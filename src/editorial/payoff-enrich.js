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

function mapSceneToOutputSec(recipe, sceneId, timelineIndex, wordIndexes) {
  const clipId = sceneId.match(/^(.+)_scene\d+$/)?.[1] ?? sceneId.split("_")[0];
  const sourceMid = resolveSceneMidSourceSec(sceneId, timelineIndex);
  if (sourceMid == null) {
    return null;
  }
  return mapSourceTimeToOutputSec(recipe, clipId, sourceMid, {
    outputKind: "main",
    wordIndexes,
  });
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

function collectPayoffCandidates(recipe, abstraction, timelineIndex, wordIndexes) {
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

function resolvePayoffTechniqueId(recipe) {
  return recipe?.audioMixPlan?.musicBed ? "music_drop" : "music_swell";
}

/**
 * Add at most one enrich_payoff_001 when structural open loops or climax/payoff L2
 * lack a retentionRole: payoff creativeMoment near the mapped scene time.
 *
 * @param {object} recipe - EditRecipe v2 draft (mutated in place)
 * @param {{ abstraction?: object, timelineIndex?: object, wordIndexes?: object[], audioIndex?: object }} [options]
 * @returns {object[]} merged creativeMoments
 */
export function enrichRecipePayoffMoments(recipe, {
  abstraction,
  timelineIndex,
  wordIndexes = null,
  audioIndex: _audioIndex = null,
} = {}) {
  void _audioIndex;

  const moments = [...(recipe?.creativeMoments ?? [])];
  const mainOutput = findMainOutput(recipe?.outputs ?? []);
  if (!mainOutput) {
    return moments;
  }

  if (moments.some((moment) => moment.momentId === PAYOFF_ENRICH_MOMENT_ID)) {
    return moments;
  }

  const toleranceSec = NAR_PAYOFF_TOLERANCE_SEC;
  const candidates = collectPayoffCandidates(recipe, abstraction, timelineIndex, wordIndexes);
  if (!candidates.length) {
    return moments;
  }

  const gapCandidate = candidates.find(
    (candidate) => !hasPayoffNearOutputSec(
      moments,
      mainOutput.outputId,
      candidate.outputSec,
      toleranceSec,
    ),
  );
  if (!gapCandidate) {
    return moments;
  }

  if (shouldSkipPayoffAtOutputSec(
    recipe,
    abstraction,
    timelineIndex,
    gapCandidate.outputSec,
    wordIndexes,
  )) {
    return moments;
  }

  const outputStartSec = gapCandidate.outputSec;
  const techniqueId = resolvePayoffTechniqueId(recipe);
  const newMoment = {
    momentId: PAYOFF_ENRICH_MOMENT_ID,
    techniqueId,
    outputId: mainOutput.outputId,
    outputStartSec,
    outputEndSec: Math.round((outputStartSec + PAYOFF_DURATION_SEC) * 10) / 10,
    retentionRole: "payoff",
    params: {},
    reason: gapCandidate.sceneId
      ? `Enriched payoff near scene ${gapCandidate.sceneId} (${gapCandidate.source})`
      : `Enriched payoff at ${outputStartSec}s (${gapCandidate.source})`,
    confidence: 0.7,
  };

  recipe.creativeMoments = [...moments, newMoment];
  return recipe.creativeMoments;
}
