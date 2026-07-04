import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import {
  findL2SegmentIdForSourceTime,
  isSlowBreathNarrativeSegment,
  resolveL2SegmentProfile,
  resolveRecipeNarrativeProfile,
  shouldPreserveSilenceForSegment,
} from "../lib/narrative-profile.js";
import { enrichRecipeDeadAirCuts } from "./dead-air-enrich.js";
import { COLD_OPEN_SEGMENT_ID } from "./chapter-hints.js";
import { buildTopSceneRanks } from "./scene-rank.js";

export const PACING_TOLERANCE = 1.05;
export const MIN_KEEP_RATIO = 0.35;
export const MAX_SEGMENT_REMOVALS = 3;
const MIN_SEGMENT_DURATION_SEC = 2;
const EDGE_TRIM_SEC = 3;
const PROTECTED_RETENTION_ROLES = new Set(["payoff", "breath", "closure"]);

function roundSec(value) {
  return Math.round(value * 10) / 10;
}

function findMainOutput(recipe) {
  return recipe.outputs?.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function sumSourceDurationSec(clipRegistry = []) {
  return clipRegistry.reduce((sum, clip) => sum + (clip.durationSec ?? 0), 0);
}

function estimateMainOutputDuration(recipe, wordIndexes) {
  const mainOutput = findMainOutput(recipe);
  if (!mainOutput?.timeline?.length) {
    return 0;
  }
  const enriched = buildOutputTimeline(mainOutput, { wordIndexes });
  if (!enriched.length) {
    return 0;
  }
  const last = enriched[enriched.length - 1];
  return last.outputEndSec ?? 0;
}

export function resolvePacingBudgetSec(recipe, estimatedKeepRatio) {
  const sourceDurationSec = sumSourceDurationSec(recipe.clipRegistry ?? []);
  if (sourceDurationSec <= 0) {
    return 0;
  }
  const keepRatio = Math.max(estimatedKeepRatio ?? MIN_KEEP_RATIO, MIN_KEEP_RATIO);
  return sourceDurationSec * keepRatio * PACING_TOLERANCE;
}

export function isOverPacingBudget(recipe, { estimatedKeepRatio, wordIndexes } = {}) {
  if (estimatedKeepRatio == null || !Number.isFinite(estimatedKeepRatio)) {
    return false;
  }
  const budgetSec = resolvePacingBudgetSec(recipe, estimatedKeepRatio);
  if (budgetSec <= 0) {
    return false;
  }
  return estimateMainOutputDuration(recipe, wordIndexes) > budgetSec;
}

function resolveSegmentSourceMid(segment) {
  const sourceIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const sourceOut = segment.audioOutSec ?? segment.videoOutSec ?? sourceIn;
  return (sourceIn + sourceOut) / 2;
}

function resolvePayoffSceneIds(abstraction) {
  const sceneIds = new Set();
  for (const segment of abstraction?.L2 ?? []) {
    if (segment.narrativeRole === "climax" || segment.narrativeRole === "payoff") {
      for (const sceneId of segment.sceneIds ?? []) {
        sceneIds.add(sceneId);
      }
    }
  }
  for (const loop of abstraction?.L3?.openLoops ?? []) {
    if (loop.payoffSceneId) {
      sceneIds.add(loop.payoffSceneId);
    }
  }
  return sceneIds;
}

function resolveColdOpenSceneIds(abstraction) {
  const sceneIds = new Set();
  for (const loop of abstraction?.L3?.openLoops ?? []) {
    if (loop.kind === "cold_open" || loop.kind === "payoff_tease") {
      if (loop.setupSceneId) {
        sceneIds.add(loop.setupSceneId);
      }
    }
  }
  return sceneIds;
}

function segmentOverlapsProtectedMoment(segment, recipe, mainOutput) {
  const segStart = segment.outputStartSec ?? 0;
  const segEnd = segment.outputEndSec ?? segStart;
  for (const moment of recipe.creativeMoments ?? []) {
    if (moment.outputId !== mainOutput.outputId) {
      continue;
    }
    if (!PROTECTED_RETENTION_ROLES.has(moment.retentionRole)) {
      continue;
    }
    const anchor = moment.outputStartSec ?? moment.anchorSec ?? 0;
    if (anchor >= segStart && anchor <= segEnd) {
      return true;
    }
  }
  return false;
}

export function isProtectedPacingSegment(
  segment,
  index,
  recipe,
  abstraction,
  timelineIndex,
  wordIndexes,
) {
  if (!segment) {
    return true;
  }

  if (index === 0 && segment.segmentId === COLD_OPEN_SEGMENT_ID) {
    return true;
  }

  const sceneId = segment.videoRef?.sceneId ?? segment.audioRef?.sceneId;
  if (sceneId && resolveColdOpenSceneIds(abstraction).has(sceneId) && index === 0) {
    return true;
  }
  if (sceneId && resolvePayoffSceneIds(abstraction).has(sceneId)) {
    return true;
  }

  if (PROTECTED_RETENTION_ROLES.has(segment.retentionRole)) {
    return true;
  }

  const mainOutput = findMainOutput(recipe);
  if (mainOutput && segmentOverlapsProtectedMoment(segment, recipe, mainOutput)) {
    return true;
  }

  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
  const l2SegmentId = findL2SegmentIdForSourceTime(
    abstraction,
    timelineIndex,
    clipId,
    resolveSegmentSourceMid(segment),
  );
  if (!l2SegmentId) {
    return false;
  }

  const l2Segment = (abstraction?.L2 ?? []).find((entry) => entry.segmentId === l2SegmentId);
  if (l2Segment?.narrativeRole === "breath") {
    return true;
  }

  const segmentProfile = resolveL2SegmentProfile(narrativeProfile, l2SegmentId);
  if (isSlowBreathNarrativeSegment(segmentProfile, l2Segment)) {
    return true;
  }
  return shouldPreserveSilenceForSegment(narrativeProfile, l2SegmentId);
}

function scoreSegmentForRemoval(segment, index, totalSegments, sceneRankById) {
  const sceneId = segment.videoRef?.sceneId ?? segment.audioRef?.sceneId;
  const rank = sceneRankById.get(sceneId) ?? 0.5;
  let score = rank;

  if (segment.segmentRole === "broll") {
    score -= 0.35;
  }
  if (index === 0 || index === totalSegments - 1) {
    score -= 0.2;
  }
  if (segment.segmentRole === "aroll") {
    score += 0.1;
  }

  return score;
}

function tryEdgeTrimSegment(segment, trimSec, trimFromStart = false) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const audioOut = segment.audioOutSec ?? segment.videoOutSec ?? audioIn;
  const duration = audioOut - audioIn;
  if (duration <= MIN_SEGMENT_DURATION_SEC + trimSec) {
    return false;
  }

  if (trimFromStart) {
    const newIn = roundSec(audioIn + trimSec);
    if (newIn >= audioOut - MIN_SEGMENT_DURATION_SEC) {
      return false;
    }
    segment.videoInSec = newIn;
    segment.audioInSec = newIn;
    return true;
  }

  const newOut = roundSec(audioOut - trimSec);
  if (newOut <= audioIn + MIN_SEGMENT_DURATION_SEC) {
    return false;
  }
  segment.videoOutSec = newOut;
  segment.audioOutSec = newOut;
  return true;
}

function buildRemovalCandidates(mainOutput, recipe, abstraction, timelineIndex, wordIndexes, sceneRankById) {
  const enriched = buildOutputTimeline(mainOutput, { wordIndexes });
  const candidates = [];

  for (let index = 0; index < enriched.length; index += 1) {
    const segment = enriched[index];
    if (isProtectedPacingSegment(segment, index, recipe, abstraction, timelineIndex, wordIndexes)) {
      continue;
    }
    candidates.push({
      index,
      score: scoreSegmentForRemoval(segment, index, enriched.length, sceneRankById),
    });
  }

  return candidates;
}

function pickRemovalCandidate(candidates, timelineLength) {
  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  const lowestScore = candidates[0].score;
  const tied = candidates.filter((candidate) => candidate.score === lowestScore);
  const edgeTied = tied.filter(
    (candidate) => candidate.index === 0 || candidate.index === timelineLength - 1,
  );
  return (edgeTied.length ? edgeTied : tied)[0];
}

/**
 * Auto-trim main output when it exceeds L3 pacing budget (V24-05 threshold).
 * Applies dead-air cuts and edge trims first, then removes up to 3 low-value edge segments.
 */
export function enrichRecipePacingTrim(recipe, {
  abstraction,
  timelineIndex,
  wordIndexes = null,
  estimatedKeepRatio,
  audioIndex = null,
  perClipAnalysis = null,
  maxSegmentRemovals = MAX_SEGMENT_REMOVALS,
} = {}) {
  if (recipe.pacingTrimMeta?.applied) {
    return recipe;
  }

  const priorMeta = recipe.pacingTrimMeta ?? {
    segmentsRemoved: 0,
    deadAirCuts: 0,
    edgeTrims: 0,
    exhausted: false,
    applied: false,
  };

  if (!isOverPacingBudget(recipe, { estimatedKeepRatio, wordIndexes })) {
    recipe.pacingTrimMeta = { ...priorMeta, applied: true };
    return recipe;
  }

  const meta = { ...priorMeta };

  const deadAirResult = enrichRecipeDeadAirCuts(recipe, {
    audioIndex,
    timelineIndex,
    wordIndexes,
    perClipAnalysis,
    abstraction,
    maxCuts: 6,
  });
  meta.deadAirCuts += deadAirResult.appliedCuts;

  if (!isOverPacingBudget(recipe, { estimatedKeepRatio, wordIndexes })) {
    recipe.pacingTrimMeta = { ...meta, exhausted: false, applied: true };
    return recipe;
  }

  if (meta.exhausted) {
    recipe.pacingTrimMeta = { ...meta, applied: true };
    return recipe;
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput?.timeline?.length) {
    recipe.pacingTrimMeta = { ...meta, exhausted: true, applied: true };
    return recipe;
  }

  const sceneRanks = buildTopSceneRanks(abstraction, timelineIndex, audioIndex, {
    clipRegistry: recipe.clipRegistry,
  });
  const sceneRankById = new Map(sceneRanks.map((entry) => [entry.sceneId, entry.rank]));

  let edgeTrimAttempts = 0;
  while (
    isOverPacingBudget(recipe, { estimatedKeepRatio, wordIndexes })
    && edgeTrimAttempts < 4
  ) {
    const enriched = buildOutputTimeline(mainOutput, { wordIndexes });
    let trimmed = false;

    for (const [index, trimFromStart] of [[0, true], [mainOutput.timeline.length - 1, false]]) {
      const segment = mainOutput.timeline[index];
      const enrichedSegment = enriched[index];
      if (!segment || !enrichedSegment) {
        continue;
      }
      if (isProtectedPacingSegment(
        enrichedSegment,
        index,
        recipe,
        abstraction,
        timelineIndex,
        wordIndexes,
      )) {
        continue;
      }
      if (tryEdgeTrimSegment(segment, EDGE_TRIM_SEC, trimFromStart)) {
        meta.edgeTrims += 1;
        trimmed = true;
        break;
      }
    }

    if (!trimmed) {
      break;
    }
    edgeTrimAttempts += 1;
  }

  if (!isOverPacingBudget(recipe, { estimatedKeepRatio, wordIndexes })) {
    recipe.pacingTrimMeta = { ...meta, exhausted: false, applied: true };
    return recipe;
  }

  const removalsRemaining = maxSegmentRemovals - (meta.segmentsRemoved ?? 0);
  for (let removal = 0; removal < removalsRemaining; removal += 1) {
    if (!isOverPacingBudget(recipe, { estimatedKeepRatio, wordIndexes })) {
      break;
    }

    const candidates = buildRemovalCandidates(
      mainOutput,
      recipe,
      abstraction,
      timelineIndex,
      wordIndexes,
      sceneRankById,
    );
    const toRemove = pickRemovalCandidate(candidates, mainOutput.timeline.length);
    if (!toRemove) {
      break;
    }

    mainOutput.timeline.splice(toRemove.index, 1);
    meta.segmentsRemoved = (meta.segmentsRemoved ?? 0) + 1;
  }

  recipe.pacingTrimMeta = {
    ...meta,
    exhausted: isOverPacingBudget(recipe, { estimatedKeepRatio, wordIndexes }),
    applied: true,
  };
  return recipe;
}
