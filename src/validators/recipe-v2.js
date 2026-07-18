import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";
import { resolveTrackById } from "../editorial/music-library.js";
import { loadTechniqueCatalog } from "../editorial/load-technique-catalog.js";
import {
  computeCreativityBudgetForRecipe,
  mergeCreativityProfile,
} from "../editorial/technique-budget.js";
import { mergeShortsRetentionProfile, mergeVlogRetentionProfile, shouldRunShortsRetentionValidation } from "../editorial/shorts-retention.js";
import { validateCreativeMoments, validateVoicePitchMoments, validateVoiceEmphasisMoments } from "./creative-moments.js";
import { validateRenderFidelity } from "./render-fidelity.js";
import { validateShortsRetention } from "./shorts-retention.js";
import { validateVlogRetention, shouldRunVlogRetentionValidation } from "./vlog-retention.js";
import {
  validateSceneRegistryV2,
  buildSceneUsageRegistryV2,
} from "./scene-registry.js";
import { validateAspectRatio, buildSceneAspectMap } from "./aspect-ratio.js";
import { validateBrollAvSync } from "./broll-av-sync.js";
import { validateBrollSyncHintAdherence } from "./broll-sync-hint-adherence.js";
import { validateChapterCardHintCoverage } from "./chapter-card-hints.js";
import { validateFillerCutCoverage } from "./filler-coverage.js";
import { validateDeadAirCoverage } from "./dead-air-coverage.js";
import { validateClosureCta } from "./closure-cta.js";
import { deriveTeaseSceneIdFromRecipe } from "../editorial/chapter-hints.js";
import { validateMultiClipChronology } from "./chronology.js";
import { validateBrollStrategy } from "./broll-strategy.js";
import { validateNarrative } from "./narrative.js";
import { validateAiVideoSegments } from "../editorial/ai-hook-enrich.js";
import { validateBrandSafetyText } from "./brand-safety.js";
import { resolveSfxById, resolveSfxByTag } from "../editorial/sfx-library.js";
import { validateSfxNarrativeOnly } from "../editorial/sfx-plan.js";
import {
  resolveRecipeNarrativeProfile,
  resolveSegmentCaps,
} from "../lib/narrative-profile.js";

function refsEqual(a, b) {
  return a.clipId === b.clipId && a.sceneId === b.sceneId;
}

function timesEqual(seg) {
  return seg.audioInSec === seg.videoInSec && seg.audioOutSec === seg.videoOutSec;
}

function getRequiredFormats(recipe) {
  return recipe.batchContext?.requiredFormats
    ?? recipe.batchContext?.minOutputs
    ?? ["16:9", "9:16"];
}

function mergeTechniqueCatalogs(catalogs) {
  const techniques = [];
  const byId = new Map();
  for (const catalog of catalogs) {
    for (const technique of catalog.techniques) {
      if (!byId.has(technique.id)) {
        byId.set(technique.id, technique);
        techniques.push(technique);
      }
    }
  }
  const primary = catalogs[0];
  return {
    version: primary.version,
    packId: catalogs.map((catalog) => catalog.packId).join("+"),
    pack: primary.pack,
    techniques,
    byId,
  };
}

function resolveValidationCatalog(parsed) {
  const platforms = parsed.batchContext?.targetPlatforms?.length
    ? parsed.batchContext.targetPlatforms
    : ["youtube", "shorts"];
  const requiredFormats = getRequiredFormats(parsed);
  const catalogs = [];

  if (shouldRunVlogRetentionValidation(parsed)) {
    const vlogProfile = mergeVlogRetentionProfile(parsed.vlogRetentionProfile ?? {}, {
      outputs: parsed.outputs,
      requiredFormats,
    });
    catalogs.push(loadTechniqueCatalog({
      pack: vlogProfile.techniquePack ?? "youtube_vlog_2026",
      platforms,
    }));
  }

  if (shouldRunShortsRetentionValidation({
    recipeVersion: parsed.version,
    outputs: parsed.outputs,
    requiredFormats,
    creativityProfile: parsed.creativityProfile ?? {},
    userContext: "",
    shortsRetentionProfile: parsed.shortsRetentionProfile ?? {},
  })) {
    const shortsProfile = mergeShortsRetentionProfile(parsed.shortsRetentionProfile ?? {}, {
      outputs: parsed.outputs,
      requiredFormats,
      creativityProfile: parsed.creativityProfile ?? {},
    });
    catalogs.push(loadTechniqueCatalog({
      pack: shortsProfile.techniquePack ?? "shorts_retention_2026",
      platforms,
    }));
  }

  if (catalogs.length === 0) {
    const preliminaryRetention = mergeShortsRetentionProfile(parsed.shortsRetentionProfile ?? {}, {
      creativityProfile: parsed.creativityProfile ?? {},
      outputs: parsed.outputs,
      requiredFormats,
    });
    const shortsValidationEnabled = shouldRunShortsRetentionValidation({
      recipeVersion: parsed.version,
      outputs: parsed.outputs,
      requiredFormats,
      creativityProfile: parsed.creativityProfile ?? {},
      shortsRetentionProfile: parsed.shortsRetentionProfile ?? {},
    });
    const packId = shortsValidationEnabled
      ? (preliminaryRetention.techniquePack ?? parsed.creativityProfile?.techniquePack)
      : (parsed.creativityProfile?.techniquePack
        ?? ((parsed.creativeMoments?.length ?? 0) > 0 ? "youtube_vlog_2026" : undefined));
    return loadTechniqueCatalog({ pack: packId, platforms });
  }

  const creativityPackId = parsed.creativityProfile?.techniquePack
    ?? ((parsed.creativeMoments?.length ?? 0) > 0 ? "youtube_vlog_2026" : null);
  if (creativityPackId && !catalogs.some((catalog) => catalog.packId === creativityPackId)) {
    catalogs.push(loadTechniqueCatalog({ pack: creativityPackId, platforms }));
  }

  return catalogs.length === 1 ? catalogs[0] : mergeTechniqueCatalogs(catalogs);
}

export function validateMediaRef(segment) {
  const issues = [];
  for (const refName of ["videoRef", "audioRef"]) {
    const ref = segment[refName];
    if (!ref) continue;
    const extraKeys = Object.keys(ref).filter((k) => !["clipId", "sceneId"].includes(k));
    if (extraKeys.length > 0) {
      issues.push({
        severity: "error",
        code: "INVALID_MEDIA_REF_TIMES",
        message: `${refName} zawiera pola czasowe: ${extraKeys.join(", ")}`,
        sceneId: ref.sceneId,
      });
    }
  }
  return issues;
}

export function validateNoSourceRef(segment, outputId) {
  if (segment.sourceRef) {
    return [{
      severity: "error",
      code: "SOURCE_REF_IN_V2_SEGMENT",
      message: `Segment ${segment.segmentId} zawiera deprecated sourceRef`,
      outputId,
      sceneId: segment.sourceRef?.sceneId,
    }];
  }
  return [];
}

export function validateTimeRanges(segment, outputId) {
  const issues = [];
  if (segment.videoOutSec <= segment.videoInSec) {
    issues.push({
      severity: "error",
      code: "INVALID_TIME_RANGE",
      message: `Segment ${segment.segmentId}: videoOutSec <= videoInSec`,
      outputId,
      sceneId: segment.videoRef?.sceneId,
    });
  }
  if (segment.audioOutSec <= segment.audioInSec
    && segment.audioPolicy !== "from_prev"
    && segment.audioPolicy !== "from_next"
    && segment.audioPolicy !== "mute") {
    issues.push({
      severity: "error",
      code: "INVALID_TIME_RANGE",
      message: `Segment ${segment.segmentId}: audioOutSec <= audioInSec`,
      outputId,
      sceneId: segment.audioRef?.sceneId,
    });
  }
  return issues;
}

export function validateAudioPolicy(segment, outputId) {
  const issues = [];
  const { videoRef, audioRef, segmentRole, audioPolicy } = segment;

  if (!videoRef || !audioRef) {
    return issues;
  }

  if (audioPolicy === "external") {
    return issues;
  }

  const sameRef = refsEqual(videoRef, audioRef);
  const sameTimes = timesEqual(segment);

  if (sameRef && sameTimes && audioPolicy !== "from_video_ref"
    && audioPolicy !== "from_prev" && audioPolicy !== "from_next" && audioPolicy !== "mute") {
    issues.push({
      severity: "error",
      code: "AUDIO_POLICY_VIOLATION",
      message: `Segment ${segment.segmentId}: równe refs i czasy wymagają from_video_ref`,
      outputId,
      sceneId: videoRef.sceneId,
    });
  }

  if (segmentRole === "broll" && (!sameRef || !sameTimes)) {
    if (audioPolicy !== "from_audio_ref" && audioPolicy !== "from_prev") {
      issues.push({
        severity: "error",
        code: "AUDIO_POLICY_VIOLATION",
        message: `Segment ${segment.segmentId}: broll z różnymi refs/czasami wymaga from_audio_ref lub from_prev`,
        outputId,
        sceneId: videoRef.sceneId,
      });
    }
  }

  if (segmentRole === "broll" && !refsEqual(videoRef, audioRef)
    && audioPolicy === "from_audio_ref"
    && segment.audioOutSec <= segment.audioInSec) {
    issues.push({
      severity: "error",
      code: "BROLL_AUDIO_MISMATCH",
      message: `Segment ${segment.segmentId}: broll cross-clip wymaga poprawnego zakresu audio`,
      outputId,
      sceneId: audioRef.sceneId,
    });
  }

  if (audioPolicy === "from_audio_ref" && audioPolicy === "from_prev") {
    // mutually exclusive - checked separately
  }
  if (audioPolicy === "from_audio_ref"
    && (segment.audioPolicy === "from_prev" || segment.audioPolicy === "from_next")) {
    issues.push({
      severity: "error",
      code: "AUDIO_POLICY_VIOLATION",
      message: `Segment ${segment.segmentId}: sprzeczne audioPolicy`,
      outputId,
    });
  }

  return issues;
}

export function validateCuts(segment, wordIndexByClip, outputId) {
  const issues = [];
  const clipId = segment.audioRef?.clipId;
  const words = wordIndexByClip.get(clipId) ?? new Set();

  for (const cut of segment.cuts ?? []) {
    if (!words.has(cut.startWordId) || !words.has(cut.endWordId)) {
      issues.push({
        severity: "error",
        code: "CUT_WORDID_WRONG_CLIP",
        message: `Cut w segmencie ${segment.segmentId} używa wordId spoza ${clipId}`,
        outputId,
        sceneId: segment.audioRef?.sceneId,
      });
    }
  }
  return issues;
}

export function validateExclusions(excluded) {
  const issues = [];
  for (const ex of excluded ?? []) {
    if (ex.exclusionType === "whole_clip") {
      if (!ex.clipId) {
        issues.push({
          severity: "error",
          code: "INVALID_EXCLUSION",
          message: "whole_clip wymaga clipId",
        });
      }
      if (ex.usableAsBroll === true) {
        issues.push({
          severity: "error",
          code: "EXCLUSION_USABLE_BROLL_WHOLE_CLIP",
          message: `whole_clip ${ex.clipId} nie może mieć usableAsBroll: true`,
        });
      }
    }
    if (ex.exclusionType === "scene" && !ex.sceneId) {
      issues.push({
        severity: "error",
        code: "INVALID_EXCLUSION",
        message: "scene exclusion wymaga sceneId",
      });
    }
    if (ex.exclusionType === "time_range") {
      if (!ex.clipId || !ex.timeRange) {
        issues.push({
          severity: "error",
          code: "INVALID_EXCLUSION",
          message: "time_range wymaga clipId i timeRange",
        });
      }
    }
  }
  return issues;
}

export function validateSubtitles(segment, outputId) {
  const issues = [];
  if (!segment.subtitles) return issues;

  if (segment.segmentRole === "broll"
    && segment.subtitles.sourceClipId !== segment.audioRef?.clipId) {
    issues.push({
      severity: "error",
      code: "SUBTITLE_SOURCE_MISMATCH",
      message: `Segment ${segment.segmentId}: subtitles.sourceClipId musi być audioRef.clipId`,
      outputId,
      sceneId: segment.videoRef?.sceneId,
    });
  }

  if (segment.subtitles.outputStartSec != null
    && segment.outputStartSec != null
    && segment.subtitles.outputStartSec < segment.outputStartSec) {
    issues.push({
      severity: "error",
      code: "SUBTITLE_TIMING_INVALID",
      message: `Segment ${segment.segmentId}: subtitles poza zakresem output`,
      outputId,
    });
  }

  return issues;
}

export function validateSyncMode(segment, outputId) {
  const issues = [];
  if (segment.syncMode === "loop_video") {
    const videoDur = segment.videoOutSec - segment.videoInSec;
    const audioDur = segment.audioOutSec - segment.audioInSec;
    if (videoDur >= audioDur) {
      issues.push({
        severity: "warning",
        code: "SYNC_MODE_MISMATCH",
        message: `Segment ${segment.segmentId}: loop_video ale wideo >= audio`,
        outputId,
        sceneId: segment.videoRef?.sceneId,
      });
    }
  }
  return issues;
}

export function validatePlaybackMode(segment, outputId) {
  const issues = [];
  const transform = segment.videoTransform;
  if (!transform) {
    return issues;
  }

  const mode = transform.playbackMode ?? "normal";
  const halfSec = transform.boomerangHalfSec;

  if (mode === "normal" && halfSec != null) {
    issues.push({
      severity: "warning",
      code: "PLAYBACK_BOOMERANG_HALF_UNUSED",
      message: `Segment ${segment.segmentId}: boomerangHalfSec bez playbackMode boomerang`,
      outputId,
      sceneId: segment.videoRef?.sceneId,
    });
  }

  if (mode === "boomerang" || mode === "reverse") {
    if (segment.audioPolicy !== "mute" && segment.audioPolicy !== "external") {
      issues.push({
        severity: "warning",
        code: "PLAYBACK_AUDIO_POLICY",
        message: `Segment ${segment.segmentId}: ${mode} wymaga audioPolicy mute lub external`,
        outputId,
        sceneId: segment.videoRef?.sceneId,
      });
    }
  }

  if (mode === "boomerang") {
    const videoDur = segment.videoOutSec - segment.videoInSec;
    if (halfSec != null && halfSec > videoDur / 2) {
      issues.push({
        severity: "warning",
        code: "PLAYBACK_BOOMERANG_HALF_CLAMPED",
        message: `Segment ${segment.segmentId}: boomerangHalfSec ${halfSec}s > połowa zakresu wideo (${(videoDur / 2).toFixed(2)}s) — renderer obetnie`,
        outputId,
        sceneId: segment.videoRef?.sceneId,
      });
    }
    if (videoDur < 0.08) {
      issues.push({
        severity: "warning",
        code: "PLAYBACK_BOOMERANG_TOO_SHORT",
        message: `Segment ${segment.segmentId}: zakres wideo zbyt krótki na boomerang`,
        outputId,
        sceneId: segment.videoRef?.sceneId,
      });
    }
  }

  return issues;
}

export function validateSegmentRole(segment, outputId) {
  if (!["aroll", "broll", "ai_hook"].includes(segment.segmentRole)) {
    return [{
      severity: "error",
      code: "INVALID_SEGMENT_ROLE",
      message: `Segment ${segment.segmentId}: niedozwolony segmentRole`,
      outputId,
    }];
  }
  return [];
}

export function validateDeprecatedFields(segment, outputId) {
  const issues = [];
  if (segment.audioOffsetSec != null) {
    issues.push({
      severity: "warning",
      code: "DEPRECATED_AUDIO_OFFSET",
      message: `Segment ${segment.segmentId}: audioOffsetSec jest deprecated w v2`,
      outputId,
    });
  }
  return issues;
}

export function validateRequiredFormats(recipe) {
  const issues = [];
  const required = getRequiredFormats(recipe);
  const present = new Set(recipe.outputs.map((o) => o.format));

  if (recipe.batchContext?.minOutputs && recipe.batchContext?.requiredFormats) {
    // requiredFormats wins — no warning
  } else if (recipe.batchContext?.minOutputs && !recipe.batchContext?.requiredFormats) {
    issues.push({
      severity: "warning",
      code: "DEPRECATED_MIN_OUTPUTS",
      message: "minOutputs jest deprecated — użyj requiredFormats",
    });
  }

  for (const format of required) {
    if (!present.has(format)) {
      issues.push({
        severity: "error",
        code: "MISSING_REQUIRED_FORMAT",
        message: `Brak outputu w formacie ${format}`,
      });
    }
  }

  const hasMain = recipe.outputs.some((o) => o.outputKind === "main");
  if (!hasMain) {
    issues.push({
      severity: "error",
      code: "MISSING_REQUIRED_FORMAT",
      message: "Brak outputu outputKind: main",
    });
  }

  return issues;
}

export function validateBrollTopicIndex(segment, topicIndex, clipRegistry, outputId) {
  const issues = [];
  if (segment.segmentRole !== "broll") {
    return issues;
  }

  const sceneId = segment.videoRef?.sceneId;
  const clipEntry = clipRegistry.find((c) => c.clipId === segment.videoRef?.clipId);

  if (clipEntry?.clipRole === "broll_pool") {
    return issues;
  }

  const inIndex = (topicIndex?.topics ?? []).some((t) =>
    t.matchingScenes.some((m) => m.sceneId === sceneId),
  );

  if (!inIndex && topicIndex?.topics?.length > 0) {
    issues.push({
      severity: "error",
      code: "BROLL_SCENE_NOT_IN_TOPIC_INDEX",
      message: `Scena B-roll ${sceneId} nie występuje w topicIndex`,
      outputId,
      sceneId,
    });
  }

  return issues;
}

export function validateMaxBroll(recipe) {
  const issues = [];
  const max = recipe.batchContext?.maxBrollSegmentsPerOutput ?? 30;
  for (const output of recipe.outputs) {
    const brollCount = output.timeline.filter((s) => s.segmentRole === "broll").length;
    if (brollCount > max) {
      issues.push({
        severity: "warning",
        code: "MAX_BROLL_EXCEEDED",
        message: `Output ${output.outputId}: ${brollCount} segmentów broll > ${max}`,
        outputId: output.outputId,
      });
    }
  }
  return issues;
}

export function validateBrollReuseWarning(recipe) {
  const issues = [];
  for (const output of recipe.outputs) {
    const counts = new Map();
    for (const seg of output.timeline) {
      if (seg.segmentRole !== "broll") continue;
      const id = seg.videoRef.sceneId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [sceneId, count] of counts) {
      if (count > 3) {
        issues.push({
          severity: "warning",
          code: "BROLL_REUSE_FREQUENT",
          message: `Scena ${sceneId} użyta ${count}× jako B-roll w ${output.outputId}`,
          outputId: output.outputId,
          sceneId,
        });
      }
    }
  }
  return issues;
}

export function validateWholeClipInSingleMode(recipe) {
  const issues = [];
  if (recipe.batchContext?.inputMode !== "single_clip") {
    return issues;
  }
  for (const ex of recipe.excluded ?? []) {
    if (ex.exclusionType === "whole_clip") {
      issues.push({
        severity: "warning",
        code: "WHOLE_CLIP_EXCLUDED_IN_SINGLE",
        message: `whole_clip excluded w trybie single_clip: ${ex.clipId}`,
      });
    }
  }
  return issues;
}

const LUFS_RANGE_MIN = -24;
const LUFS_RANGE_MAX = -12;

function parseRecipeVersion(version) {
  const majorMinor = parseFloat(String(version ?? "0"));
  return Number.isFinite(majorMinor) ? majorMinor : 0;
}

function hasV24SfxFields(recipe) {
  return parseRecipeVersion(recipe.version) >= 2.4
    || (recipe.sfxPlan?.length ?? 0) > 0;
}

function hasV24PresetFields(recipe) {
  return parseRecipeVersion(recipe.version) >= 2.4
    || recipe.renderStylePresets != null;
}

function buildClipDurationMap(clipRegistry = []) {
  return new Map(clipRegistry.map((clip) => [clip.clipId, clip.durationSec ?? 0]));
}

function buildClipRegistryMap(clipRegistry = []) {
  return new Map(clipRegistry.map((clip) => [clip.clipId, clip]));
}

function clipHasSpeech(clip) {
  if (!clip) {
    return false;
  }
  return clip.hasSpeech === true || (clip.speechWordCount ?? 0) > 0;
}

export function hasNarrationSegments(recipe) {
  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.audioPolicy === "from_audio_ref") {
        return true;
      }
    }
  }
  return false;
}

export function validateVoiceoverSegments(segment, clipRegistryMap, outputId) {
  const issues = [];

  if (segment.audioPolicy === "from_audio_ref" && segment.audioRef?.clipId) {
    const audioClip = clipRegistryMap.get(segment.audioRef.clipId);
    if (audioClip && !clipHasSpeech(audioClip)) {
      issues.push({
        severity: "error",
        code: "V25-VO-01",
        message: `Segment ${segment.segmentId}: from_audio_ref wymaga audioRef z mową (hasSpeech)`,
        outputId,
        sceneId: segment.audioRef.sceneId,
      });
    }
  }

  if (segment.subtitles?.policy && segment.subtitles.policy !== "off"
    && segment.subtitles.sourceClipId) {
    const sourceClip = clipRegistryMap.get(segment.subtitles.sourceClipId);
    if (sourceClip && !clipHasSpeech(sourceClip)) {
      issues.push({
        severity: "error",
        code: "V25-VO-02",
        message: `Segment ${segment.segmentId}: subtitles.sourceClipId musi wskazywać klip z transkryptem (hasSpeech)`,
        outputId,
        sceneId: segment.videoRef?.sceneId,
      });
    }
  }

  return issues;
}

export function validateAudioMixPlan(recipe, { catalogPath } = {}) {
  const issues = [];
  const plan = recipe.audioMixPlan;
  if (!plan) {
    return issues;
  }

  for (const [field, label] of [
    ["voiceTargetLufs", "voiceTargetLufs"],
    ["preWhisperNormalizeLufs", "preWhisperNormalizeLufs"],
  ]) {
    const value = plan[field];
    if (value != null && (value < LUFS_RANGE_MIN || value > LUFS_RANGE_MAX)) {
      issues.push({
        severity: "warning",
        code: "V23-02",
        message: `${label} ${value} LUFS poza zalecanym zakresem [${LUFS_RANGE_MIN}, ${LUFS_RANGE_MAX}]`,
      });
    }
  }

  if (plan.musicBed?.trackId) {
    const { track, reason } = resolveTrackById(plan.musicBed.trackId, { catalogPath });
    if (!track) {
      issues.push({
        severity: "error",
        code: "V23-03",
        message: reason === "track_not_in_catalog"
          ? `musicBed.trackId "${plan.musicBed.trackId}" nie występuje w katalogu muzyki`
          : `Plik muzyki dla trackId "${plan.musicBed.trackId}" nie istnieje na dysku`,
      });
    }
  }

  for (const segment of plan.segments ?? []) {
    const windowCount = segment.duckingWindows?.length ?? 0;
    if (windowCount > 16) {
      issues.push({
        severity: "warning",
        code: "V24-09",
        message: `audioMixPlan segment ${segment.outputId}: duckingWindows ma ${windowCount} wpisów (max 16)`,
        outputId: segment.outputId,
      });
    }
  }

  if (!plan.musicBed) {
    return issues;
  }

  const outputIds = new Set((plan.segments ?? []).map((s) => s.outputId));
  if (outputIds.size === 0) {
    for (const output of recipe.outputs) {
      outputIds.add(output.outputId);
    }
  }

  for (const outputId of outputIds) {
    const output = recipe.outputs.find((o) => o.outputId === outputId);
    if (!output) {
      continue;
    }
    const hasExternal = output.timeline.some((seg) => seg.audioPolicy === "external");
    if (!hasExternal) {
      issues.push({
        severity: "warning",
        code: "V23-01",
        message: `Output ${outputId}: musicBed wymaga co najmniej jednego segmentu z audioPolicy: external`,
        outputId,
      });
    }
  }

  return issues;
}

export function validateSfxPlan(recipe, { clipDurations } = {}) {
  const issues = [];
  const sfxPlan = recipe.sfxPlan;
  if (!sfxPlan?.length) {
    return issues;
  }

  const durations = clipDurations ?? buildClipDurationMap(recipe.clipRegistry);
  const clipIds = new Set((recipe.clipRegistry ?? []).map((clip) => clip.clipId));

  for (const entry of sfxPlan) {
    const {
      sfxId,
      source,
      clipId,
      outputStartSec,
      outputEndSec,
      anchorTimeSec,
    } = entry;

    if (source === "audio_event" && (!clipId || !clipIds.has(clipId))) {
      issues.push({
        severity: "error",
        code: "V24-01",
        message: `sfxPlan ${sfxId}: source=audio_event wymaga clipId z clipRegistry`,
      });
    }

    if (outputStartSec >= outputEndSec) {
      issues.push({
        severity: "error",
        code: "V24-02",
        message: `sfxPlan ${sfxId}: outputStartSec (${outputStartSec}) >= outputEndSec (${outputEndSec})`,
      });
    }

    if (clipId && anchorTimeSec != null) {
      const durationSec = durations.get(clipId);
      if (durationSec != null && durationSec > 0
        && (anchorTimeSec < 0 || anchorTimeSec > durationSec)) {
        issues.push({
          severity: "error",
          code: "V24-03",
          message: `sfxPlan ${sfxId}: anchorTimeSec ${anchorTimeSec} poza zakresem clipu ${clipId} (0–${durationSec}s)`,
        });
      }
    }
  }

  return issues;
}

export function validateSfxPlanCatalog(recipe) {
  const issues = [];
  for (const entry of recipe.sfxPlan ?? []) {
    if (entry.source !== "library") {
      continue;
    }
    if (resolveSfxById(entry.sfxId).sound) {
      continue;
    }
    if (entry.label && resolveSfxByTag(entry.label).sound) {
      continue;
    }
    issues.push({
      severity: "warning",
      code: "V24-07",
      message: `sfxPlan ${entry.sfxId}: brak w katalogu SFX (sfxId ani tag "${entry.label ?? ""}")`,
    });
  }
  return issues;
}

export const SFX_DENSITY_SEC_PER_ENTRY = 90;

export function resolveSfxDensityMaxEntries(recipe, { abstraction } = {}) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (narrativeProfile) {
    const l2SegmentIds = (abstraction?.L2 ?? []).map((segment) => segment.segmentId);
    const segmentIds = l2SegmentIds.length > 0
      ? l2SegmentIds
      : (narrativeProfile.segments ?? []).map((segment) => segment.l2SegmentId).filter(Boolean);

    if (segmentIds.length > 0) {
      let sum = 0;
      for (const segmentId of segmentIds) {
        const caps = resolveSegmentCaps(narrativeProfile, segmentId, abstraction);
        sum += caps?.maxSfxEntries ?? 0;
      }
      return sum;
    }
  }

  const mainDurationSec = estimateMainOutputDurationSec(recipe.outputs ?? []);
  if (mainDurationSec <= 0) {
    return Infinity;
  }
  return Math.ceil(mainDurationSec / SFX_DENSITY_SEC_PER_ENTRY);
}

export function validateSfxDensityOnMain(recipe, { abstraction } = {}) {
  const sfxPlan = recipe.sfxPlan;
  if (!sfxPlan?.length) {
    return [];
  }

  const mainDurationSec = estimateMainOutputDurationSec(recipe.outputs ?? []);
  if (mainDurationSec <= 0) {
    return [];
  }

  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const maxEntries = resolveSfxDensityMaxEntries(recipe, { abstraction });
  if (sfxPlan.length <= maxEntries) {
    return [];
  }

  const mainOutputId = recipe.outputs?.find((output) => output.outputKind === "main")?.outputId
    ?? recipe.outputs?.[0]?.outputId;

  const capLabel = narrativeProfile
    ? "narrativeProfile L2 caps"
    : `${mainDurationSec.toFixed(0)}s, 1/90s`;

  return [{
    severity: "warning",
    code: "V24-06",
    message: `sfxPlan ma ${sfxPlan.length} wpisów — max ${maxEntries} na main (${capLabel})`,
    outputId: mainOutputId,
  }];
}

export function validateRenderStylePresets(recipe) {
  const issues = [];
  const hasVerticalOutput = (recipe.outputs ?? []).some((output) => output.format === "9:16");
  if (!hasVerticalOutput) {
    return issues;
  }

  const safeZone = recipe.renderStylePresets?.formats?.["9:16"]?.safeZone;
  if (!safeZone) {
    issues.push({
      severity: "warning",
      code: "V24-04",
      message: "Output 9:16 bez safeZone w renderStylePresets.formats[\"9:16\"]",
    });
  }

  return issues;
}

function estimateRecipeDurationSec(recipe) {
  let maxSec = 0;
  for (const output of recipe.outputs ?? []) {
    for (const seg of output.timeline) {
      const end = seg.outputEndSec
        ?? (seg.outputStartSec ?? 0) + (seg.videoOutSec - seg.videoInSec);
      maxSec = Math.max(maxSec, end);
    }
  }
  if (maxSec > 0) {
    return maxSec;
  }
  return (recipe.clipRegistry ?? []).reduce((sum, c) => sum + (c.durationSec ?? 0), 0) || 600;
}

function sumSourceDurationSec(clipRegistry = []) {
  return clipRegistry.reduce((sum, clip) => sum + (clip.durationSec ?? 0), 0);
}

function estimateMainOutputDurationSec(outputs = []) {
  const mains = outputs.filter((output) => output.outputKind === "main");
  const targets = mains.length > 0 ? mains : outputs;
  let maxSec = 0;

  for (const output of targets) {
    for (const seg of output.timeline ?? []) {
      const end = seg.outputEndSec
        ?? (seg.outputStartSec ?? 0) + (seg.videoOutSec - seg.videoInSec);
      maxSec = Math.max(maxSec, end);
    }
  }

  return maxSec;
}

const PACING_TOLERANCE = 1.05;

export function validatePacingGuard(recipe, { estimatedKeepRatio } = {}) {
  const issues = [];
  const sourceDurationSec = sumSourceDurationSec(recipe.clipRegistry ?? []);
  if (sourceDurationSec <= 0) {
    return issues;
  }

  const outputDurationSec = estimateMainOutputDurationSec(recipe.outputs ?? []);
  if (outputDurationSec <= 0) {
    return issues;
  }

  const qualityOverQuantity = recipe.batchContext?.qualityOverQuantity ?? true;
  const ratio = outputDurationSec / sourceDurationSec;

  if (qualityOverQuantity && ratio > PACING_TOLERANCE) {
    issues.push({
      severity: "warning",
      code: "V24-05",
      message: `Main output ${outputDurationSec.toFixed(1)}s przekracza ${(PACING_TOLERANCE * 100).toFixed(0)}% materiału źródłowego (${sourceDurationSec.toFixed(1)}s) przy qualityOverQuantity`,
      outputId: recipe.outputs?.find((output) => output.outputKind === "main")?.outputId,
    });
  }

  if (
    estimatedKeepRatio != null
    && outputDurationSec > sourceDurationSec * estimatedKeepRatio * PACING_TOLERANCE
  ) {
    const targetSec = sourceDurationSec * estimatedKeepRatio;
    issues.push({
      severity: "warning",
      code: "V24-05",
      message: `Main output ${outputDurationSec.toFixed(1)}s przekracza L3 estimatedKeepRatio (${(estimatedKeepRatio * 100).toFixed(0)}% → ~${targetSec.toFixed(1)}s)`,
      outputId: recipe.outputs?.find((output) => output.outputKind === "main")?.outputId,
    });
  }

  return issues;
}

function hasNarrationTrack(clipRegistry = []) {
  return clipRegistry.some(
    (clip) => clip.clipRole === "narration_track"
      || (clip.mediaType === "audio_only" && clip.hasSpeech),
  );
}

export function validateSalvageAndAudioQuality(recipe, {
  audioEnhancementIndex = null,
  perClipAnalysis = null,
} = {}) {
  const issues = [];
  const clipRegistryMap = buildClipRegistryMap(recipe.clipRegistry);
  const narrationAvailable = hasNarrationTrack(recipe.clipRegistry);

  if (recipe.editorialAssessment?.verdict === "salvage_required" && !recipe.salvagePlan) {
    issues.push({
      severity: "error",
      code: "SALVAGE-01",
      message: "editorialAssessment.salvage_required wymaga salvagePlan",
    });
  }

  if (recipe.editorialAssessment?.verdict === "not_recommended" && !recipe.needsHumanReview) {
    issues.push({
      severity: "warning",
      code: "SALVAGE-04",
      message: "Materiał not_recommended powinien ustawić needsHumanReview: true",
    });
  }

  const voProposal = recipe.salvagePlan?.voiceOverProposal;
  if (
    voProposal?.materializationStatus === "missing_narration"
    && !recipe.needsHumanReview
  ) {
    issues.push({
      severity: "warning",
      code: "SALVAGE-04",
      message: "Propozycja voice-over bez narration_track wymaga needsHumanReview",
    });
  }

  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.audioPolicy !== "from_audio_ref") {
        continue;
      }
      const audioClipId = segment.audioRef?.clipId;
      const clip = audioClipId ? clipRegistryMap.get(audioClipId) : null;
      if (!clip || !clipHasSpeech(clip)) {
        if (!narrationAvailable && voProposal?.materializationStatus === "missing_narration") {
          issues.push({
            severity: "error",
            code: "SALVAGE-02",
            message: `Segment ${segment.segmentId}: from_audio_ref bez istniejącego narration asset`,
            outputId: output.outputId,
          });
        }
      }
    }
  }

  const enhancementByClip = new Map(
    (audioEnhancementIndex?.clips ?? []).map((entry) => [entry.clipId, entry]),
  );
  const analysisByClip = new Map(
    (Array.isArray(perClipAnalysis) ? perClipAnalysis : [])
      .map((entry) => [entry.clipId, entry]),
  );

  for (const decision of recipe.audioEnhancementDecisions ?? []) {
    if (decision.action !== "accept") {
      continue;
    }
    const manifest = enhancementByClip.get(decision.clipId);
    if (!manifest || (manifest.status !== "succeeded" && manifest.status !== "stubbed")) {
      const recoveryHint = manifest?.status === "failed"
        ? ` — sprawdź ${"17-recovery-plan.json"} (errorCode: ${manifest.errorCode ?? "unknown"})`
        : "";
      issues.push({
        severity: "error",
        code: manifest?.status === "failed" ? "AUD-QUAL-06" : "AUD-QUAL-01",
        message: `accept dla ${decision.clipId} bez udanego artefaktu audio_enhancement${recoveryHint}`,
      });
    } else if (!manifest.normalization?.finalIntegratedLufs) {
      issues.push({
        severity: "warning",
        code: "AUD-QUAL-05",
        message: `Brak pomiaru post-enhancement dla ${decision.clipId}`,
      });
    }
  }

  for (const [clipId, analysis] of analysisByClip.entries()) {
    const grade = analysis.audioQuality?.grade;
    if (grade !== "poor" && grade !== "unusable") {
      continue;
    }
    const hasDecision = (recipe.audioEnhancementDecisions ?? []).some(
      (entry) => entry.clipId === clipId,
    );
    const usedAsDialogue = (recipe.outputs ?? []).some((output) =>
      (output.timeline ?? []).some((segment) => {
        const audioClipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
        return audioClipId === clipId
          && segment.audioPolicy !== "mute"
          && segment.segmentRole !== "broll";
      }),
    );
    if (usedAsDialogue && !hasDecision) {
      issues.push({
        severity: "warning",
        code: "AUD-QUAL-02",
        message: `Klip ${clipId} ma audioQuality=${grade} bez decyzji enhancement/exclusion`,
      });
    }
  }

  return issues;
}

export function validateDeliveryEngagement(recipe, { perClipAnalysis = null } = {}) {
  const issues = [];
  const analysisByClip = new Map(
    (Array.isArray(perClipAnalysis) ? perClipAnalysis : [])
      .map((entry) => [entry.clipId, entry]),
  );

  for (const moment of recipe.engagementRepairMoments ?? []) {
    if (moment.action !== "voice_resynthesis") {
      continue;
    }
    if (!moment.consentRequired || !moment.needsHumanReview) {
      issues.push({
        severity: "error",
        code: "V27-DELIVERY-03",
        message: `engagementRepairMoments ${moment.momentId}: voice_resynthesis wymaga consentRequired i needsHumanReview`,
        momentId: moment.momentId,
      });
    }
    const duration = (moment.endSec ?? 0) - (moment.startSec ?? 0);
    if (duration > 30) {
      issues.push({
        severity: "warning",
        code: "V27-DELIVERY-04",
        message: `engagementRepairMoments ${moment.momentId}: fragment re-syntezy ${duration.toFixed(1)}s > 30s`,
        momentId: moment.momentId,
      });
    }
  }

  for (const decision of recipe.audioEnhancementDecisions ?? []) {
    if (decision.action !== "accept") {
      continue;
    }
    const preset = decision.polishPreset ?? "none";
    if (preset === "none" || preset === "repair_only") {
      continue;
    }
    const analysis = analysisByClip.get(decision.clipId);
    const windScore = analysis?.audioQuality?.windScore ?? 0;
    if (windScore >= 0.45) {
      issues.push({
        severity: "warning",
        code: "V27-DELIVERY-05",
        message: `Klip ${decision.clipId}: polishPreset ${preset} przy wysokim windScore (${windScore})`,
        clipId: decision.clipId,
      });
    }
  }

  const emphasisCount = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.techniqueId === "voice_emphasis_boost"
      || moment.techniqueId === "voice_pitch_shift",
  ).length;
  const repairCount = (recipe.engagementRepairMoments ?? []).length;
  if (emphasisCount + repairCount > 8) {
    issues.push({
      severity: "warning",
      code: "V27-DELIVERY-02",
      message: `Zbyt wiele interwencji prozodii (${emphasisCount + repairCount}) — ryzyko utraty naturalności głosu`,
    });
  }

  return issues;
}

export function validateRecipeV2(recipe, {
  requiredFormats,
  topicIndex,
  spatialIndex,
  sceneAspectById,
  wordIndexes = [],
  audioIndex = null,
  techniqueCatalog,
  creativityBudget,
  estimatedKeepRatio,
  musicCatalogPath,
  brollSyncHints,
  chapterCardHints,
  abstraction = null,
  timelineIndex = null,
  perClipAnalysis = null,
  audioEnhancementIndex = null,
  qualityProfile = "lenient",
} = {}) {
  const parsed = EditRecipeV2Schema.parse(recipe);
  const formats = requiredFormats ?? getRequiredFormats(parsed);

  const wordIndexByClip = new Map();
  const allWordIds = new Set();
  for (const wi of wordIndexes) {
    const clipId = wi.clipId ?? wi.words?.[0]?.wordId?.split("_")?.[0];
    const ids = (wi.words ?? []).map((w) => w.wordId);
    wordIndexByClip.set(clipId, new Set(ids));
    for (const id of ids) {
      allWordIds.add(id);
    }
  }
  if (wordIndexByClip.size === 0 && parsed.outputs.length > 0) {
    // fallback: skip cut validation when no word index provided
  }

  const catalog = techniqueCatalog ?? resolveValidationCatalog(parsed);
  const profile = mergeCreativityProfile(parsed.creativityProfile ?? {}, {
    defaultCreativityLevel: catalog.pack?.defaultCreativityLevel,
  });
  const budget = creativityBudget ?? computeCreativityBudgetForRecipe(parsed, profile);

  const audioIndexByClip = new Map();
  if (audioIndex?.clips) {
    for (const clip of audioIndex.clips) {
      audioIndexByClip.set(clip.clipId, clip);
    }
  }

  const clipRegistryMap = buildClipRegistryMap(parsed.clipRegistry);
  const narrationPresent = hasNarrationSegments(parsed);
  const brollStrategy = parsed.batchContext?.brollStrategy ?? "match_speech_topics";

  const issues = [
    ...validateRequiredFormats(parsed),
    ...validateExclusions(parsed.excluded),
    ...validateSceneRegistryV2(parsed),
    ...validateMaxBroll(parsed),
    ...validateBrollReuseWarning(parsed),
    ...validateWholeClipInSingleMode(parsed),
    ...validateAudioMixPlan(parsed, { catalogPath: musicCatalogPath }),
    ...validatePacingGuard(parsed, { estimatedKeepRatio }),
    ...(hasV24SfxFields(parsed) ? [
      ...validateSfxPlan(parsed),
      ...validateSfxDensityOnMain(parsed, { abstraction }),
      ...validateSfxPlanCatalog(parsed),
      ...validateSfxNarrativeOnly(parsed, { wordIndexes }),
    ] : []),
    ...validateAspectRatio(parsed, { sceneAspectById }),
    ...validateBrollAvSync(parsed),
    ...validateBrollSyncHintAdherence(parsed, { brollSyncHints }),
    ...validateChapterCardHintCoverage(recipe, { chapterCardHints, wordIndexes }),
    ...validateFillerCutCoverage(parsed, { abstraction, timelineIndex }),
    ...validateDeadAirCoverage(parsed, {
      audioIndex,
      abstraction,
      timelineIndex,
      wordIndexes,
      perClipAnalysis,
    }),
    ...validateClosureCta(parsed, { abstraction, wordIndexes }),
    ...validateMultiClipChronology(parsed, {
      teaseSceneId: deriveTeaseSceneIdFromRecipe(parsed),
    }),
    ...validateBrollStrategy(parsed, { topicIndex }),
    ...(hasV24PresetFields(parsed) ? validateRenderStylePresets(parsed) : []),
    ...validateCreativeMoments(parsed, catalog, budget, {
      wordIds: allWordIds.size > 0 ? allWordIds : null,
      spatialIndex,
      audioIndexByClip: audioIndexByClip.size > 0 ? audioIndexByClip : null,
      abstraction,
      timelineIndex,
      wordIndexes,
    }),
    ...validateVoicePitchMoments(parsed),
    ...validateVoiceEmphasisMoments(parsed),
    ...validateDeliveryEngagement(parsed, { perClipAnalysis }),
    ...validateRenderFidelity(parsed, { qualityProfile }),
    ...validateShortsRetention(parsed, catalog, {
      creativityLevel: profile.level,
      wordIndexes,
      timelineIndex,
      abstraction,
    }),
    ...validateVlogRetention(parsed, catalog, {
      creativityLevel: profile.level,
      retentionBeatTargets: parsed.retentionBeatTargets,
      abstraction,
      timelineIndex,
      wordIndexes,
    }),
    ...validateNarrative(parsed, {
      abstraction,
      timelineIndex,
      audioIndex,
      wordIndexes,
    }),
    ...validateAiVideoSegments(parsed, parsed.batchContext ?? {}),
    ...validateBrandSafetyText(parsed),
    ...validateSalvageAndAudioQuality(parsed, {
      audioEnhancementIndex,
      perClipAnalysis,
    }),
  ];

  for (const output of parsed.outputs) {
    for (const segment of output.timeline) {
      issues.push(
        ...validateNoSourceRef(segment, output.outputId),
        ...validateMediaRef(segment),
        ...validateTimeRanges(segment, output.outputId),
        ...validateAudioPolicy(segment, output.outputId),
        ...validateSegmentRole(segment, output.outputId),
        ...validateSubtitles(segment, output.outputId),
        ...validateSyncMode(segment, output.outputId),
        ...validatePlaybackMode(segment, output.outputId),
        ...validateDeprecatedFields(segment, output.outputId),
        ...(brollStrategy !== "match_speech_topics"
          ? validateBrollTopicIndex(segment, topicIndex, parsed.clipRegistry, output.outputId)
          : []),
      );
      if (wordIndexByClip.size > 0) {
        issues.push(...validateCuts(segment, wordIndexByClip, output.outputId));
      }
      if (narrationPresent) {
        issues.push(...validateVoiceoverSegments(segment, clipRegistryMap, output.outputId));
      }
    }
  }

  return {
    valid: issues.filter((i) => i.severity === "error").length === 0,
    issues,
    recipe: parsed,
  };
}

export { buildSceneUsageRegistryV2 };
