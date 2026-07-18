import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import {
  isOverPacingBudget,
  MAX_SEGMENT_REMOVALS,
  resolvePacingBudgetSec,
} from "../editorial/pacing-enrich.js";
import {
  findL2SegmentIdForSourceTime,
  isSlowBreathNarrativeSegment,
  resolveL2OutputRangeSec,
  resolveRecipeNarrativeProfile,
  shouldPreserveSilenceForSegment,
} from "../lib/narrative-profile.js";
import { mapSourceTimeToOutputSec } from "../editorial/shorts-retention.js";
import { buildAudioIndexSummary, lookupWordIndex } from "../editorial/audio-index-summary.js";
import { isVlogRetentionBeatMoment } from "./vlog-retention.js";
import { isRetentionBeatMoment } from "../editorial/shorts-retention.js";

export const NAR_PAYOFF_TOLERANCE_SEC = 30;
export const NAR_SLOW_SEGMENT_MAX_BEATS = 1;
export const NAR_SLOW_SEGMENT_MAX_ENRICH_BEATS = 0;
export const NAR_CLOSURE_MAX_BEATS = 1;
export const NAR_CLOSURE_MAX_ENRICH_BEATS = 0;

/** Narrative codes promoted to error in internet_documentary hard mode. */
export const NAR_HARD_MODE_CODES = new Set([
  "NAR-BREATH-BEAT",
  "NAR-BEAT-SPAM",
  "NAR-CLOSURE-SPAM",
  "NAR-PAYOFF-UNDELIVERED",
  "NAR-PAYOFF-MISSING",
  "NAR-CALLBACK-UNDELIVERED",
  "NAR-DRAMATIC-PAUSE-CUT",
]);

/**
 * Resolve issue severity — internet_documentary promotes NAR_HARD_MODE_CODES to error.
 */
export function resolveNarrativeIssueSeverity(code, narrativeProfile, defaultSeverity = "warning") {
  if (narrativeProfile?.mode !== "internet_documentary") {
    return defaultSeverity;
  }
  if (!NAR_HARD_MODE_CODES.has(code)) {
    return defaultSeverity;
  }
  return "error";
}

function pushNarrativeIssue(issues, narrativeProfile, code, defaultSeverity, fields) {
  issues.push({
    severity: resolveNarrativeIssueSeverity(code, narrativeProfile, defaultSeverity),
    code,
    ...fields,
  });
}

const BREATH_BEAT_TECHNIQUE_IDS = new Set(["pattern_interrupt", "snap_zoom"]);

function findMainOutput(recipe) {
  return recipe.outputs?.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  ) ?? recipe.outputs?.[0];
}

function isSlowNarrativeSegment(segmentProfile, abstractionSegment) {
  return isSlowBreathNarrativeSegment(segmentProfile, abstractionSegment);
}

function resolveSceneMidSourceSec(sceneId, timelineIndex) {
  const scene = (timelineIndex?.scenes ?? []).find((entry) => entry.sceneId === sceneId);
  if (!scene) {
    return null;
  }
  const start = scene.startSec ?? 0;
  const end = scene.endSec ?? start + (scene.durationSec ?? 0);
  return (start + end) / 2;
}

function momentNearOutputSec(moment, targetSec, toleranceSec) {
  const anchor = moment.outputStartSec ?? moment.anchorSec ?? 0;
  return Math.abs(anchor - targetSec) <= toleranceSec;
}

function hasPayoffNearScene(recipe, mainOutput, sceneId, timelineIndex, toleranceSec, wordIndexes) {
  const clipId = sceneId.match(/^(.+)_scene\d+$/)?.[1] ?? sceneId.split("_")[0];
  const sourceMid = resolveSceneMidSourceSec(sceneId, timelineIndex);
  let targetOutputSec = sourceMid != null
    ? mapSourceTimeToOutputSec(recipe, clipId, sourceMid, { outputKind: "main", wordIndexes })
    : null;

  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  const segmentWithScene = enrichedTimeline.find(
    (segment) => segment.videoRef?.sceneId === sceneId
      || segment.audioRef?.sceneId === sceneId,
  );

  // Scene mid often falls outside trimmed in/out — use segment midpoint instead.
  if (targetOutputSec == null && segmentWithScene) {
    const start = segmentWithScene.outputStartSec ?? 0;
    const end = segmentWithScene.outputEndSec ?? start;
    targetOutputSec = (start + end) / 2;
  }

  const payoffMoments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId
      && moment.retentionRole === "payoff",
  );

  if (targetOutputSec != null) {
    // Prefer payoffs that land on the scene's own segment when present.
    if (segmentWithScene) {
      const start = segmentWithScene.outputStartSec ?? 0;
      const end = segmentWithScene.outputEndSec ?? start;
      const onSegment = payoffMoments.some((moment) => {
        const anchor = moment.outputStartSec ?? moment.anchorSec ?? 0;
        return anchor >= start - 0.5 && anchor <= end + 0.5;
      });
      if (onSegment) {
        return true;
      }
    } else if (payoffMoments.some((moment) => momentNearOutputSec(moment, targetOutputSec, toleranceSec))) {
      return true;
    }
  }

  if (segmentWithScene) {
    const hasPayoffOverlay = (segmentWithScene.textOverlays ?? []).some(
      (overlay) => overlay.role === "payoff",
    );
    if (hasPayoffOverlay) {
      return true;
    }
  }

  return false;
}

function hasPayoffOverlayOnScene(mainOutput, sceneId, wordIndexes) {
  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  const segmentWithScene = enrichedTimeline.find(
    (segment) => segment.videoRef?.sceneId === sceneId
      || segment.audioRef?.sceneId === sceneId,
  );
  if (!segmentWithScene) {
    return false;
  }
  return (segmentWithScene.textOverlays ?? []).some(
    (overlay) => overlay.role === "payoff",
  );
}

function hasCallbackDeliveryNearScene(
  recipe,
  mainOutput,
  sceneId,
  timelineIndex,
  toleranceSec,
  wordIndexes,
) {
  const clipId = sceneId.match(/^(.+)_scene\d+$/)?.[1] ?? sceneId.split("_")[0];
  const sourceMid = resolveSceneMidSourceSec(sceneId, timelineIndex);
  const targetOutputSec = sourceMid != null
    ? mapSourceTimeToOutputSec(recipe, clipId, sourceMid, { outputKind: "main", wordIndexes })
    : null;

  const matchCutMoments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId
      && moment.techniqueId === "match_cut",
  );

  if (targetOutputSec != null) {
    if (matchCutMoments.some((moment) => momentNearOutputSec(moment, targetOutputSec, toleranceSec))) {
      return true;
    }
  }

  return hasPayoffOverlayOnScene(mainOutput, sceneId, wordIndexes);
}

function resolveOpenLoopsForValidation(abstraction) {
  return (abstraction?.L3?.openLoops ?? []).filter(
    (loop) => loop.kind === "cold_open" || loop.kind === "payoff_tease",
  );
}

/**
 * NAR-PAYOFF-UNDELIVERED — cold_open / payoff_tease without payoff near payoffSceneId.
 */
export function validateNarrativePayoff(recipe, {
  abstraction,
  timelineIndex,
  toleranceSec = NAR_PAYOFF_TOLERANCE_SEC,
  wordIndexes = null,
} = {}) {
  const teaseLoops = resolveOpenLoopsForValidation(abstraction);
  if (!teaseLoops.length) {
    return [];
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput) {
    return [];
  }

  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const issues = [];
  for (const loop of teaseLoops) {
    if (!loop.payoffSceneId) {
      continue;
    }

    if (hasPayoffNearScene(recipe, mainOutput, loop.payoffSceneId, timelineIndex, toleranceSec, wordIndexes)) {
      continue;
    }

    pushNarrativeIssue(issues, narrativeProfile, "NAR-PAYOFF-UNDELIVERED", "warning", {
      message: `Open loop ${loop.loopId} (${loop.kind}): brak momentu payoff przy scenie ${loop.payoffSceneId}`,
      outputId: mainOutput.outputId,
      sceneId: loop.payoffSceneId,
    });
  }

  return issues;
}

function resolveClimaxL2Segment(abstraction) {
  const l2 = abstraction?.L2 ?? [];
  if (!l2.length) {
    return null;
  }
  const climaxSegment = l2.find((entry) => entry.narrativeRole === "climax");
  return climaxSegment ?? l2[l2.length - 1];
}

/**
 * NAR-PAYOFF-MISSING — final/climax L2 segment lacks retentionRole: payoff on main output.
 */
export function validateNarrativePayoffMissing(recipe, {
  abstraction,
  wordIndexes = null,
} = {}) {
  const teaseLoops = resolveOpenLoopsForValidation(abstraction);
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (!teaseLoops.length && !narrativeProfile?.mode) {
    return [];
  }

  const climaxSegment = resolveClimaxL2Segment(abstraction);
  if (!climaxSegment) {
    return [];
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput) {
    return [];
  }

  const range = resolveL2OutputRangeSec(
    climaxSegment.segmentId,
    abstraction,
    recipe,
    mainOutput,
    wordIndexes,
  );
  if (!range) {
    return [];
  }

  const payoffMoments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId
      && moment.retentionRole === "payoff",
  );

  const hasPayoffInRange = payoffMoments.some(
    (moment) => momentInOutputRange(moment, range),
  );
  if (hasPayoffInRange || hasPayoffOverlayInRange(mainOutput, range, wordIndexes)) {
    return [];
  }

  return [{
    severity: resolveNarrativeIssueSeverity("NAR-PAYOFF-MISSING", narrativeProfile, "warning"),
    code: "NAR-PAYOFF-MISSING",
    message: `Segment L2 ${climaxSegment.segmentId} (kulminacja): brak creativeMoment retentionRole: payoff ani overlay role: payoff w zakresie outputu`,
    outputId: mainOutput.outputId,
  }];
}

function isBeatMoment(moment) {
  if (moment.retentionRole === "beat") {
    return true;
  }
  if (moment.retentionRole === "hook" || moment.retentionRole === "payoff") {
    return false;
  }
  return isRetentionBeatMoment(moment) || isVlogRetentionBeatMoment(moment);
}

function isBreathBeatMoment(moment) {
  if (moment.retentionRole === "beat") {
    return true;
  }
  if (moment.retentionRole === "hook" || moment.retentionRole === "payoff"
    || moment.retentionRole === "breath" || moment.retentionRole === "closure") {
    return false;
  }
  return BREATH_BEAT_TECHNIQUE_IDS.has(moment.techniqueId);
}

function momentInOutputRange(moment, range) {
  const anchor = moment.outputStartSec ?? 0;
  return anchor >= range.startSec && anchor <= range.endSec;
}

function segmentOverlapsRange(segment, range) {
  const segStart = segment.outputStartSec ?? 0;
  const segEnd = segment.outputEndSec ?? segStart;
  return segEnd >= range.startSec && segStart <= range.endSec;
}

function hasPayoffOverlayInRange(mainOutput, range, wordIndexes) {
  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  for (const segment of enrichedTimeline) {
    if (!segmentOverlapsRange(segment, range)) {
      continue;
    }
    for (const overlay of segment.textOverlays ?? []) {
      if (overlay.role !== "payoff") {
        continue;
      }
      if (overlay.outputStartSec != null) {
        if (overlay.outputStartSec >= range.startSec && overlay.outputStartSec <= range.endSec) {
          return true;
        }
      } else {
        return true;
      }
    }
  }
  return false;
}

/**
 * NAR-BEAT-SPAM — too many enrich_beat_* or beats in slow narrativeProfile segments.
 */
export function validateNarrativeBeatSpam(recipe, {
  abstraction,
  maxBeats = NAR_SLOW_SEGMENT_MAX_BEATS,
  maxEnrichBeats = NAR_SLOW_SEGMENT_MAX_ENRICH_BEATS,
  wordIndexes = null,
} = {}) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (!narrativeProfile?.segments?.length) {
    return [];
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput) {
    return [];
  }

  const moments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId,
  );
  const issues = [];

  const l2ById = new Map((abstraction?.L2 ?? []).map((entry) => [entry.segmentId, entry]));

  for (const segmentProfile of narrativeProfile.segments) {
    if (!isSlowNarrativeSegment(segmentProfile, l2ById.get(segmentProfile.l2SegmentId))) {
      continue;
    }

    const range = resolveL2OutputRangeSec(
      segmentProfile.l2SegmentId,
      abstraction,
      recipe,
      mainOutput,
      wordIndexes,
    );
    if (!range) {
      continue;
    }

    const beatsInRange = moments.filter(
      (moment) => isBeatMoment(moment) && momentInOutputRange(moment, range),
    );
    const enrichBeats = beatsInRange.filter((moment) => moment.momentId?.startsWith("enrich_beat_"));

    if (enrichBeats.length > maxEnrichBeats) {
      pushNarrativeIssue(issues, narrativeProfile, "NAR-BEAT-SPAM", "warning", {
        message: `Segment L2 ${segmentProfile.l2SegmentId} (slow/low): ${enrichBeats.length} enrich_beat_* — max ${maxEnrichBeats} w wolnej sekcji narracji`,
        outputId: mainOutput.outputId,
      });
      continue;
    }

    if (beatsInRange.length > maxBeats) {
      pushNarrativeIssue(issues, narrativeProfile, "NAR-BEAT-SPAM", "warning", {
        message: `Segment L2 ${segmentProfile.l2SegmentId} (slow/low): ${beatsInRange.length} beatów retencji — max ${maxBeats} w wolnej sekcji narracji`,
        outputId: mainOutput.outputId,
      });
    }
  }

  return issues;
}

function resolveCutSourceMidSec(cut, segment, wordIndex) {
  if (!wordIndex?.words?.length) {
    return null;
  }

  const wordById = new Map(wordIndex.words.map((word) => [word.wordId, word]));
  const startWord = wordById.get(cut.startWordId);
  const endWord = wordById.get(cut.endWordId);
  if (!startWord || !endWord) {
    return null;
  }

  return (startWord.end + endWord.start) / 2;
}

function isDramaticPauseHint(hint) {
  return hint.kind === "dramatic_pause"
    || hint.silenceKind === "dramatic_pause";
}

function deadAirHintsForCutValidation(clipId, audioIndex, taggedClipsById) {
  const tagged = taggedClipsById?.get(clipId)?.deadAirHints ?? [];
  const raw = (audioIndex?.clips ?? []).find((entry) => entry.clipId === clipId)?.deadAirHints ?? [];
  if (!tagged.length) {
    return raw;
  }

  const rawByKey = new Map(
    raw.map((hint) => [`${hint.startSec}:${hint.endSec}`, hint]),
  );
  const merged = tagged.map((hint) => {
    const rawHint = rawByKey.get(`${hint.startSec}:${hint.endSec}`);
    if (isDramaticPauseHint(rawHint)) {
      return {
        ...hint,
        kind: rawHint.kind ?? hint.kind,
        silenceKind: "dramatic_pause",
      };
    }
    return hint;
  });

  const seen = new Set(merged.map((hint) => `${hint.startSec}:${hint.endSec}`));
  for (const hint of raw) {
    const key = `${hint.startSec}:${hint.endSec}`;
    if (!seen.has(key)) {
      merged.push(hint);
    }
  }
  return merged;
}

function cutOverlapsDramaticPause(cutMidSec, clipId, audioIndex, taggedClipsById = null) {
  if (cutMidSec == null) {
    return false;
  }

  for (const hint of deadAirHintsForCutValidation(clipId, audioIndex, taggedClipsById)) {
    if (!isDramaticPauseHint(hint)) {
      continue;
    }
    if (cutMidSec >= hint.startSec && cutMidSec <= hint.endSec) {
      return true;
    }
  }

  return false;
}

/**
 * NAR-DRAMATIC-PAUSE-CUT — dead_air cut in preserve segment or dramatic_pause region.
 */
export function validateNarrativeDramaticPauseCuts(recipe, {
  abstraction,
  timelineIndex,
  audioIndex = null,
  wordIndexes = null,
} = {}) {
  const mainOutput = findMainOutput(recipe);
  if (!mainOutput?.timeline?.length) {
    return [];
  }

  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const taggedAudioSummary = audioIndex
    ? buildAudioIndexSummary(audioIndex, {
      wordIndexes,
      timelineIndex,
      narrativeProfile,
    })
    : null;
  const taggedClipsById = new Map(
    (taggedAudioSummary?.clips ?? []).map((clip) => [clip.clipId, clip]),
  );
  const issues = [];

  for (const segment of mainOutput.timeline) {
    const deadAirCuts = (segment.cuts ?? []).filter((cut) => cut.reason === "dead_air");
    if (!deadAirCuts.length) {
      continue;
    }

    const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
    const wordIndex = lookupWordIndex(clipId, wordIndexes, timelineIndex);

    for (const cut of deadAirCuts) {
      const cutMidSec = resolveCutSourceMidSec(cut, segment, wordIndex);

      if (cutOverlapsDramaticPause(cutMidSec, clipId, audioIndex, taggedClipsById)) {
        pushNarrativeIssue(issues, narrativeProfile, "NAR-DRAMATIC-PAUSE-CUT", "warning", {
          message: `Segment ${segment.segmentId}: cięcie dead_air w regionie dramatic_pause (${clipId})`,
          outputId: mainOutput.outputId,
          sceneId: segment.videoRef?.sceneId,
        });
        continue;
      }

      if (!narrativeProfile || cutMidSec == null) {
        continue;
      }

      const l2SegmentId = findL2SegmentIdForSourceTime(
        abstraction,
        timelineIndex,
        clipId,
        cutMidSec,
      );
      if (!l2SegmentId) {
        continue;
      }

      if (shouldPreserveSilenceForSegment(narrativeProfile, l2SegmentId)) {
        pushNarrativeIssue(issues, narrativeProfile, "NAR-DRAMATIC-PAUSE-CUT", "error", {
          message: `Segment ${segment.segmentId}: cięcie dead_air w L2 ${l2SegmentId} z silencePolicy preserve`,
          outputId: mainOutput.outputId,
          sceneId: segment.videoRef?.sceneId,
        });
      }
    }
  }

  return issues;
}

/**
 * NAR-BREATH-BEAT — beat / pattern_interrupt / snap_zoom in breath or slow L2 segment.
 */
export function validateNarrativeBreathBeat(recipe, {
  abstraction,
  wordIndexes = null,
} = {}) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const l2ById = new Map((abstraction?.L2 ?? []).map((entry) => [entry.segmentId, entry]));
  const breathSlowSegmentIds = new Set();

  for (const l2Segment of abstraction?.L2 ?? []) {
    if (l2Segment.narrativeRole === "breath") {
      breathSlowSegmentIds.add(l2Segment.segmentId);
    }
  }
  for (const segmentProfile of narrativeProfile?.segments ?? []) {
    if (segmentProfile.rhythm === "slow") {
      breathSlowSegmentIds.add(segmentProfile.l2SegmentId);
    }
  }

  if (!breathSlowSegmentIds.size) {
    return [];
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput) {
    return [];
  }

  const moments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId,
  );
  const issues = [];

  for (const l2SegmentId of breathSlowSegmentIds) {
    const range = resolveL2OutputRangeSec(
      l2SegmentId,
      abstraction,
      recipe,
      mainOutput,
      wordIndexes,
    );
    if (!range) {
      continue;
    }

    const violations = moments.filter(
      (moment) => isBreathBeatMoment(moment) && momentInOutputRange(moment, range),
    );
    if (!violations.length) {
      continue;
    }

    const l2Segment = l2ById.get(l2SegmentId);
    const label = l2Segment?.narrativeRole === "breath" ? "breath" : "slow";
    pushNarrativeIssue(issues, narrativeProfile, "NAR-BREATH-BEAT", "warning", {
      message: `Segment L2 ${l2SegmentId} (${label}): beat/pattern_interrupt/snap_zoom w sekcji oddechu — usuń lub przenieś`,
      outputId: mainOutput.outputId,
    });
  }

  return issues;
}

function resolveResolutionL2Segment(abstraction) {
  const l2 = abstraction?.L2 ?? [];
  if (!l2.length) {
    return null;
  }
  const resolutionSegment = l2.find((entry) => entry.narrativeRole === "resolution");
  return resolutionSegment ?? l2[l2.length - 1];
}

/**
 * NAR-CLOSURE-SPAM — enrich_beat_* or >1 beat in final L2 resolution segment.
 */
export function validateNarrativeClosureSpam(recipe, {
  abstraction,
  maxBeats = NAR_CLOSURE_MAX_BEATS,
  maxEnrichBeats = NAR_CLOSURE_MAX_ENRICH_BEATS,
  wordIndexes = null,
} = {}) {
  const resolutionSegment = resolveResolutionL2Segment(abstraction);
  if (!resolutionSegment) {
    return [];
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput) {
    return [];
  }

  const range = resolveL2OutputRangeSec(
    resolutionSegment.segmentId,
    abstraction,
    recipe,
    mainOutput,
    wordIndexes,
  );
  if (!range) {
    return [];
  }

  const moments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId,
  );
  const beatsInRange = moments.filter(
    (moment) => isBeatMoment(moment) && momentInOutputRange(moment, range),
  );
  const enrichBeats = beatsInRange.filter((moment) => moment.momentId?.startsWith("enrich_beat_"));
  const issues = [];

  if (enrichBeats.length > maxEnrichBeats) {
    pushNarrativeIssue(issues, resolveRecipeNarrativeProfile(recipe), "NAR-CLOSURE-SPAM", "warning", {
      message: `Segment L2 ${resolutionSegment.segmentId} (resolution): ${enrichBeats.length} enrich_beat_* — max ${maxEnrichBeats} w zamknięciu`,
      outputId: mainOutput.outputId,
    });
    return issues;
  }

  if (beatsInRange.length > maxBeats) {
    pushNarrativeIssue(issues, resolveRecipeNarrativeProfile(recipe), "NAR-CLOSURE-SPAM", "warning", {
      message: `Segment L2 ${resolutionSegment.segmentId} (resolution): ${beatsInRange.length} beatów retencji — max ${maxBeats} w zamknięciu`,
      outputId: mainOutput.outputId,
    });
  }

  return issues;
}

function resolveCallbackLoopsForValidation(abstraction) {
  return (abstraction?.L3?.openLoops ?? []).filter((loop) => loop.kind === "callback");
}

/**
 * NAR-CALLBACK-UNDELIVERED — callback openLoop without match_cut or payoff overlay near payoffSceneId.
 */
export function validateNarrativeCallbackUndelivered(recipe, {
  abstraction,
  timelineIndex,
  toleranceSec = NAR_PAYOFF_TOLERANCE_SEC,
  wordIndexes = null,
} = {}) {
  const callbackLoops = resolveCallbackLoopsForValidation(abstraction);
  if (!callbackLoops.length) {
    return [];
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput) {
    return [];
  }

  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const issues = [];
  for (const loop of callbackLoops) {
    if (!loop.payoffSceneId) {
      continue;
    }

    if (hasCallbackDeliveryNearScene(
      recipe,
      mainOutput,
      loop.payoffSceneId,
      timelineIndex,
      toleranceSec,
      wordIndexes,
    )) {
      continue;
    }

    pushNarrativeIssue(issues, narrativeProfile, "NAR-CALLBACK-UNDELIVERED", "warning", {
      message: `Open loop ${loop.loopId} (callback): brak match_cut ani overlay role: payoff przy scenie ${loop.payoffSceneId}`,
      outputId: mainOutput.outputId,
      sceneId: loop.payoffSceneId,
    });
  }

  return issues;
}

/**
 * NAR-PACING-TRIM-EXHAUSTED — pacing auto-trim could not bring main output within budget.
 */
export function validateNarrativePacingTrimExhausted(recipe, {
  abstraction,
  estimatedKeepRatio,
  wordIndexes = null,
} = {}) {
  const resolvedKeepRatio = estimatedKeepRatio ?? abstraction?.L3?.estimatedKeepRatio;
  if (!isOverPacingBudget(recipe, { estimatedKeepRatio: resolvedKeepRatio, wordIndexes })) {
    return [];
  }

  const meta = recipe.pacingTrimMeta;
  if (!meta?.exhausted) {
    return [];
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput) {
    return [];
  }

  const budgetSec = resolvePacingBudgetSec(recipe, resolvedKeepRatio);
  return [{
    severity: "warning",
    code: "NAR-PACING-TRIM-EXHAUSTED",
    message: `Pacing auto-trim wyczerpany — main output nadal przekracza budżet (~${budgetSec.toFixed(1)}s, max ${MAX_SEGMENT_REMOVALS} usunięć segmentów)`,
    outputId: mainOutput.outputId,
  }];
}

export function validateNarrative(recipe, options = {}) {
  return [
    ...validateNarrativePayoff(recipe, options),
    ...validateNarrativePayoffMissing(recipe, options),
    ...validateNarrativeBeatSpam(recipe, options),
    ...validateNarrativeBreathBeat(recipe, options),
    ...validateNarrativeClosureSpam(recipe, options),
    ...validateNarrativeCallbackUndelivered(recipe, options),
    ...validateNarrativeDramaticPauseCuts(recipe, options),
    ...validateNarrativePacingTrimExhausted(recipe, options),
  ];
}
