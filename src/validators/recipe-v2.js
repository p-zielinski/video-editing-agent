import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";
import { loadTechniqueCatalog } from "../editorial/load-technique-catalog.js";
import {
  computeCreativityBudget,
  mergeCreativityProfile,
} from "../editorial/technique-budget.js";
import { mergeShortsRetentionProfile } from "../editorial/shorts-retention.js";
import { validateCreativeMoments } from "./creative-moments.js";
import { validateShortsRetention } from "./shorts-retention.js";
import {
  validateSceneRegistryV2,
  buildSceneUsageRegistryV2,
} from "./scene-registry.js";

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

export function validateSegmentRole(segment, outputId) {
  if (!["aroll", "broll"].includes(segment.segmentRole)) {
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

export function validateAudioMixPlan(recipe) {
  const issues = [];
  const plan = recipe.audioMixPlan;
  if (!plan?.musicBed) {
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
      code: "V24-01",
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
      code: "V24-01",
      message: `Main output ${outputDurationSec.toFixed(1)}s przekracza L3 estimatedKeepRatio (${(estimatedKeepRatio * 100).toFixed(0)}% → ~${targetSec.toFixed(1)}s)`,
      outputId: recipe.outputs?.find((output) => output.outputKind === "main")?.outputId,
    });
  }

  return issues;
}

export function validateRecipeV2(recipe, {
  requiredFormats,
  topicIndex,
  spatialIndex,
  wordIndexes = [],
  audioIndex = null,
  techniqueCatalog,
  creativityBudget,
  estimatedKeepRatio,
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

  const preliminaryRetention = mergeShortsRetentionProfile(parsed.shortsRetentionProfile ?? {}, {
    creativityProfile: parsed.creativityProfile ?? {},
    outputs: parsed.outputs,
    requiredFormats: getRequiredFormats(parsed),
  });
  const packId = preliminaryRetention.enabled
    ? (preliminaryRetention.techniquePack ?? parsed.creativityProfile?.techniquePack)
    : parsed.creativityProfile?.techniquePack;

  const catalog = techniqueCatalog ?? loadTechniqueCatalog({
    pack: packId,
    platforms: parsed.batchContext?.targetPlatforms?.length
      ? parsed.batchContext.targetPlatforms
      : ["youtube", "shorts"],
  });
  const profile = mergeCreativityProfile(parsed.creativityProfile ?? {}, {
    defaultCreativityLevel: catalog.pack?.defaultCreativityLevel,
  });
  const durationSec = estimateRecipeDurationSec(parsed);
  const budget = creativityBudget ?? computeCreativityBudget(durationSec, profile);

  const audioIndexByClip = new Map();
  if (audioIndex?.clips) {
    for (const clip of audioIndex.clips) {
      audioIndexByClip.set(clip.clipId, clip);
    }
  }

  const issues = [
    ...validateRequiredFormats(parsed),
    ...validateExclusions(parsed.excluded),
    ...validateSceneRegistryV2(parsed),
    ...validateMaxBroll(parsed),
    ...validateBrollReuseWarning(parsed),
    ...validateWholeClipInSingleMode(parsed),
    ...validateAudioMixPlan(parsed),
    ...validatePacingGuard(parsed, { estimatedKeepRatio }),
    ...validateCreativeMoments(parsed, catalog, budget, {
      wordIds: allWordIds.size > 0 ? allWordIds : null,
      spatialIndex,
      audioIndexByClip: audioIndexByClip.size > 0 ? audioIndexByClip : null,
    }),
    ...validateShortsRetention(parsed, catalog, { creativityLevel: profile.level }),
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
        ...validateDeprecatedFields(segment, output.outputId),
        ...validateBrollTopicIndex(segment, topicIndex, parsed.clipRegistry, output.outputId),
      );
      if (wordIndexByClip.size > 0) {
        issues.push(...validateCuts(segment, wordIndexByClip, output.outputId));
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
