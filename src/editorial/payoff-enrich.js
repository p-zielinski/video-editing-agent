import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import {
  findL2SegmentIdForSourceTime,
  isSlowBreathNarrativeSegment,
  resolveL2OutputRangeSec,
  resolveL2SegmentProfile,
  resolveRecipeNarrativeProfile,
  shouldPreserveSilenceForSegment,
} from "../lib/narrative-profile.js";
import { mapSourceTimeToOutputSec } from "./shorts-retention.js";
import { NAR_PAYOFF_TOLERANCE_SEC } from "../validators/narrative.js";

export const PAYOFF_ENRICH_MOMENT_ID = "enrich_payoff_001";
const PAYOFF_DURATION_SEC = 3;

function findMainOutput(outputs = []) {
  return outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
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

function hasPayoffNearOutputSec(moments, outputId, targetSec, toleranceSec) {
  return moments.some(
    (moment) => moment.outputId === outputId
      && moment.retentionRole === "payoff"
      && momentNearOutputSec(moment, targetSec, toleranceSec),
  );
}

/** True when a payoff moment lands on the timeline segment for this scene. */
function hasPayoffOnSceneSegment(moments, outputId, sceneId, mainOutput, wordIndexes) {
  if (!sceneId || !mainOutput) {
    return false;
  }
  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  const segment = enrichedTimeline.find(
    (entry) => entry.videoRef?.sceneId === sceneId
      || entry.audioRef?.sceneId === sceneId,
  );
  if (!segment) {
    return false;
  }
  const start = segment.outputStartSec ?? 0;
  const end = segment.outputEndSec ?? start;
  return moments.some((moment) => {
    if (moment.outputId !== outputId || moment.retentionRole !== "payoff") {
      return false;
    }
    const anchor = moment.outputStartSec ?? moment.anchorSec ?? 0;
    return anchor >= start - 0.5 && anchor <= end + 0.5;
  });
}

function mapSceneToOutputSec(recipe, sceneId, timelineIndex, wordIndexes) {
  const clipId = sceneId.match(/^(.+)_scene\d+$/)?.[1] ?? sceneId.split("_")[0];
  const sourceMid = resolveSceneMidSourceSec(sceneId, timelineIndex);
  if (sourceMid != null) {
    const mapped = mapSourceTimeToOutputSec(recipe, clipId, sourceMid, {
      outputKind: "main",
      wordIndexes,
    });
    if (mapped != null) {
      return mapped;
    }
  }

  // Scene mid may fall outside the trimmed in/out window — use segment output midpoint.
  const mainOutput = findMainOutput(recipe?.outputs ?? []);
  if (!mainOutput) {
    return null;
  }
  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  for (const segment of enrichedTimeline) {
    const segmentSceneId = segment.videoRef?.sceneId ?? segment.audioRef?.sceneId;
    if (segmentSceneId !== sceneId) {
      continue;
    }
    const start = segment.outputStartSec ?? 0;
    const end = segment.outputEndSec ?? start;
    return Math.round(((start + end) / 2) * 10) / 10;
  }

  return null;
}

function resolveL2SegmentForScene(abstraction, sceneId) {
  for (const segment of abstraction?.L2 ?? []) {
    if ((segment.sceneIds ?? []).includes(sceneId)) {
      return segment;
    }
  }
  return null;
}

function shouldSkipPayoffAtOutputSec(recipe, abstraction, timelineIndex, outputSec, wordIndexes) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (!narrativeProfile) {
    return false;
  }

  const mainOutput = findMainOutput(recipe.outputs ?? []);
  if (!mainOutput) {
    return false;
  }

  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  const segment = enrichedTimeline.find(
    (entry) => outputSec >= (entry.outputStartSec ?? 0)
      && outputSec < (entry.outputEndSec ?? Infinity),
  );
  if (!segment) {
    return false;
  }

  const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
  const sourceIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const sourceOffset = outputSec - (segment.outputStartSec ?? 0);
  const sourceTimeSec = sourceIn + sourceOffset;

  const l2SegmentId = findL2SegmentIdForSourceTime(
    abstraction,
    timelineIndex,
    clipId,
    sourceTimeSec,
  );
  if (!l2SegmentId) {
    return false;
  }

  const l2Segment = (abstraction?.L2 ?? []).find((entry) => entry.segmentId === l2SegmentId);
  const segmentProfile = resolveL2SegmentProfile(narrativeProfile, l2SegmentId);
  if (!isSlowBreathNarrativeSegment(segmentProfile, l2Segment)) {
    return false;
  }

  return shouldPreserveSilenceForSegment(narrativeProfile, l2SegmentId);
}

function collectPayoffCandidates(recipe, abstraction, timelineIndex, wordIndexes, emotionalBeatHints = []) {
  const mainOutput = findMainOutput(recipe.outputs ?? []);
  if (!mainOutput) {
    return [];
  }

  const candidates = [];
  const seenKeys = new Set();

  function pushCandidate(candidate) {
    if (candidate.outputSec == null || !Number.isFinite(candidate.outputSec)) {
      return;
    }
    const key = `${candidate.source}:${candidate.l2SegmentId ?? candidate.sceneId ?? candidate.outputSec}`;
    if (seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    candidates.push(candidate);
  }

  for (const loop of abstraction?.L3?.openLoops ?? []) {
    if (loop.kind !== "cold_open" && loop.kind !== "payoff_tease") {
      continue;
    }
    if (!loop.payoffSceneId) {
      continue;
    }
    const outputSec = mapSceneToOutputSec(recipe, loop.payoffSceneId, timelineIndex, wordIndexes);
    const l2Segment = resolveL2SegmentForScene(abstraction, loop.payoffSceneId);
    pushCandidate({
      outputSec,
      sceneId: loop.payoffSceneId,
      l2SegmentId: l2Segment?.segmentId ?? null,
      source: `openLoop:${loop.loopId ?? loop.kind}`,
    });
  }

  for (const hint of emotionalBeatHints ?? []) {
    if (!hint.sceneId) {
      continue;
    }
    let resolvedSec = mapSceneToOutputSec(recipe, hint.sceneId, timelineIndex, wordIndexes);
    if (resolvedSec == null && hint.anchorTimeSec != null) {
      const clipId = hint.clipId
        ?? hint.sceneId.match(/^(.+)_scene\d+$/)?.[1]
        ?? hint.sceneId.split("_")[0];
      resolvedSec = mapSourceTimeToOutputSec(recipe, clipId, hint.anchorTimeSec, {
        outputKind: "main",
        wordIndexes,
      });
    }
    const l2Segment = resolveL2SegmentForScene(abstraction, hint.sceneId);
    pushCandidate({
      outputSec: resolvedSec,
      sceneId: hint.sceneId,
      l2SegmentId: l2Segment?.segmentId ?? null,
      source: `emotionalBeat:${hint.mood ?? hint.retentionRole ?? "payoff"}`,
    });
  }

  for (const segment of abstraction?.L2 ?? []) {
    if (segment.narrativeRole !== "climax" && segment.narrativeRole !== "payoff") {
      continue;
    }
    const range = resolveL2OutputRangeSec(
      segment.segmentId,
      abstraction,
      recipe,
      mainOutput,
      wordIndexes,
    );
    if (!range) {
      continue;
    }
    const outputSec = Math.round(((range.startSec + range.endSec) / 2) * 10) / 10;
    pushCandidate({
      outputSec,
      sceneId: segment.sceneIds?.[0] ?? null,
      l2SegmentId: segment.segmentId,
      source: `l2:${segment.narrativeRole}`,
    });
  }

  return candidates;
}

function resolvePayoffTechniqueId(recipe, enrichIndex = 1) {
  if (recipe?.creativityProfile?.level === "safe") {
    return "cut_on_beat";
  }
  // First payoff can use music bed techniques; later ones avoid V21 density/gap on music_drop
  // and avoid stacking camera zoom duty with retention beats.
  if (enrichIndex > 1) {
    return "silence_beat";
  }
  return recipe?.audioMixPlan?.musicBed ? "music_drop" : "music_swell";
}

function countPayoffEnrichMoments(moments = []) {
  let maxIndex = 0;
  for (const moment of moments) {
    const match = /^enrich_payoff_(\d+)$/.exec(moment.momentId ?? "");
    if (match) {
      maxIndex = Math.max(maxIndex, Number(match[1]));
    }
  }
  return maxIndex;
}

function buildPayoffMoment(recipe, mainOutput, candidate, enrichIndex) {
  const outputStartSec = candidate.outputSec;
  return {
    momentId: `enrich_payoff_${String(enrichIndex).padStart(3, "0")}`,
    techniqueId: resolvePayoffTechniqueId(recipe, enrichIndex),
    outputId: mainOutput.outputId,
    outputStartSec,
    outputEndSec: Math.round((outputStartSec + PAYOFF_DURATION_SEC) * 10) / 10,
    retentionRole: "payoff",
    params: {},
    reason: candidate.sceneId
      ? `Enriched payoff near scene ${candidate.sceneId} (${candidate.source})`
      : `Enriched payoff at ${outputStartSec}s (${candidate.source})`,
    confidence: 0.7,
  };
}

/**
 * Add enrich_payoff_* moments for undelivered open loops (and at most one structural
 * L2/emotional gap when no open-loop payoffs are missing).
 *
 * @param {object} recipe - EditRecipe v2 draft (mutated in place)
 * @param {{ abstraction?: object, timelineIndex?: object, wordIndexes?: object[], audioIndex?: object, emotionalBeatHints?: object[] }} [options]
 * @returns {object[]} merged creativeMoments
 */
export function enrichRecipePayoffMoments(recipe, {
  abstraction,
  timelineIndex,
  wordIndexes = null,
  audioIndex: _audioIndex = null,
  emotionalBeatHints = null,
} = {}) {
  void _audioIndex;

  const moments = [...(recipe?.creativeMoments ?? [])];
  const mainOutput = findMainOutput(recipe?.outputs ?? []);
  if (!mainOutput) {
    return moments;
  }

  const toleranceSec = NAR_PAYOFF_TOLERANCE_SEC;
  const candidates = collectPayoffCandidates(
    recipe,
    abstraction,
    timelineIndex,
    wordIndexes,
    emotionalBeatHints,
  );
  if (!candidates.length) {
    return moments;
  }

  const openLoopCandidates = candidates.filter((candidate) => (
    String(candidate.source ?? "").startsWith("openLoop:")
  ));
  const structuralCandidates = candidates.filter((candidate) => (
    !String(candidate.source ?? "").startsWith("openLoop:")
  ));

  let enrichIndex = countPayoffEnrichMoments(moments);
  const coverageMoments = [...moments];

  function tryAddPayoff(candidate, { requireSceneSegment = false } = {}) {
    if (candidate.outputSec == null || !Number.isFinite(candidate.outputSec)) {
      return false;
    }
    if (requireSceneSegment && candidate.sceneId) {
      const onScene = hasPayoffOnSceneSegment(
        coverageMoments,
        mainOutput.outputId,
        candidate.sceneId,
        mainOutput,
        wordIndexes,
      );
      // When the scene id is not present as a labeled segment (common in tests /
      // single-clip timelines), fall back to proximity on the mapped output time.
      const sceneLabeled = buildOutputTimeline(mainOutput, { wordIndexes }).some(
        (entry) => entry.videoRef?.sceneId === candidate.sceneId
          || entry.audioRef?.sceneId === candidate.sceneId,
      );
      if (onScene || (!sceneLabeled && hasPayoffNearOutputSec(
        coverageMoments,
        mainOutput.outputId,
        candidate.outputSec,
        toleranceSec,
      ))) {
        return false;
      }
    } else if (hasPayoffNearOutputSec(
      coverageMoments,
      mainOutput.outputId,
      candidate.outputSec,
      toleranceSec,
    )) {
      return false;
    }
    if (shouldSkipPayoffAtOutputSec(
      recipe,
      abstraction,
      timelineIndex,
      candidate.outputSec,
      wordIndexes,
    )) {
      return false;
    }
    enrichIndex += 1;
    const moment = buildPayoffMoment(recipe, mainOutput, candidate, enrichIndex);
    coverageMoments.push(moment);
    return true;
  }

  for (const candidate of openLoopCandidates) {
    tryAddPayoff(candidate, { requireSceneSegment: true });
  }

  const addedOpenLoopPayoff = coverageMoments.length > moments.length;
  if (!addedOpenLoopPayoff) {
    for (const candidate of structuralCandidates) {
      if (tryAddPayoff(candidate)) {
        break;
      }
    }
  }

  recipe.creativeMoments = coverageMoments;
  return recipe.creativeMoments;
}
