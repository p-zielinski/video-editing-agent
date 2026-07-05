import { lookupWordIndex } from "./audio-index-summary.js";
import {
  computeSceneFillerRatio,
  HIGH_FILLER_RATIO_THRESHOLD,
} from "../validators/filler-coverage.js";
import {
  findL2SegmentIdForSourceTime,
  isSlowBreathNarrativeSegment,
  resolveL2SegmentProfile,
  resolveRecipeNarrativeProfile,
  shouldAllowFillerCutsForL2,
  shouldPreserveSilenceForSegment,
} from "../lib/narrative-profile.js";

function findMainOutput(recipe) {
  return recipe.outputs?.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function resolveSegmentRange(segment) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const audioOut = segment.audioOutSec ?? segment.videoOutSec ?? audioIn;
  return { audioIn, audioOut };
}

function findSegmentForScene(timeline, sceneId, sceneMeta) {
  const sceneStart = sceneMeta?.startSec ?? 0;
  const sceneEnd = sceneMeta?.endSec ?? sceneStart + (sceneMeta?.durationSec ?? 0);

  for (const segment of timeline) {
    const segSceneId = segment.videoRef?.sceneId ?? segment.audioRef?.sceneId;
    if (segSceneId === sceneId) {
      return segment;
    }

    const clipId = segment.videoRef?.clipId ?? segment.audioRef?.clipId;
    if (clipId !== sceneMeta?.clipId) {
      continue;
    }

    const { audioIn, audioOut } = resolveSegmentRange(segment);
    if (audioIn < sceneEnd && audioOut > sceneStart) {
      return segment;
    }
  }

  return null;
}

function collectFillerWordRanges(sceneId, timelineIndex) {
  const sceneMeta = (timelineIndex?.scenes ?? []).find((entry) => entry.sceneId === sceneId);
  if (!sceneMeta) {
    return [];
  }

  const words = (timelineIndex?.words ?? [])
    .filter(
      (word) => word.start >= sceneMeta.startSec && word.start < sceneMeta.endSec,
    )
    .sort((a, b) => a.start - b.start);

  const ranges = [];
  let current = null;

  for (const word of words) {
    if (!word.isFiller) {
      if (current) {
        ranges.push(current);
        current = null;
      }
      continue;
    }

    if (!current) {
      current = { startWordId: word.wordId, endWordId: word.wordId };
    } else {
      current.endWordId = word.wordId;
    }
  }

  if (current) {
    ranges.push(current);
  }

  return ranges;
}

function hasFillerCut(segment, startWordId, endWordId) {
  return (segment.cuts ?? []).some(
    (cut) => cut.reason === "filler"
      && cut.startWordId === startWordId
      && cut.endWordId === endWordId,
  );
}

function shouldSkipFillerCutsForSegment(recipe, abstraction, timelineIndex, segment) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (!narrativeProfile) {
    return false;
  }

  const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
  const { audioIn, audioOut } = resolveSegmentRange(segment);
  const sourceMid = (audioIn + audioOut) / 2;
  const l2SegmentId = findL2SegmentIdForSourceTime(
    abstraction,
    timelineIndex,
    clipId,
    sourceMid,
  );
  if (!l2SegmentId) {
    return false;
  }

  if (!shouldAllowFillerCutsForL2(narrativeProfile, l2SegmentId)) {
    return true;
  }

  const l2Segment = (abstraction?.L2 ?? []).find((entry) => entry.segmentId === l2SegmentId);
  const segmentProfile = resolveL2SegmentProfile(narrativeProfile, l2SegmentId);
  if (isSlowBreathNarrativeSegment(segmentProfile, l2Segment)) {
    return true;
  }

  return shouldPreserveSilenceForSegment(narrativeProfile, l2SegmentId);
}

/**
 * Add filler cuts for L1 scenes with high filler ratio when director omitted cuts[].
 *
 * @param {object} recipe - EditRecipe v2 draft (mutated in place)
 * @param {{ abstraction?: object, timelineIndex?: object, wordIndexes?: object[] }} [options]
 * @returns {number} applied cut count
 */
export function enrichRecipeFillerCuts(recipe, {
  abstraction,
  timelineIndex,
  wordIndexes = null,
} = {}) {
  const mainOutput = findMainOutput(recipe);
  if (!mainOutput?.timeline?.length || !abstraction?.L1?.length || !timelineIndex?.words?.length) {
    return 0;
  }

  let appliedCuts = 0;

  for (const scene of abstraction.L1) {
    const fillerRatio = computeSceneFillerRatio(scene.sceneId, timelineIndex);
    if (fillerRatio <= HIGH_FILLER_RATIO_THRESHOLD) {
      continue;
    }

    const sceneMeta = (timelineIndex.scenes ?? []).find(
      (entry) => entry.sceneId === scene.sceneId,
    );
    const segment = findSegmentForScene(mainOutput.timeline, scene.sceneId, sceneMeta);
    if (!segment) {
      continue;
    }

    if (shouldSkipFillerCutsForSegment(recipe, abstraction, timelineIndex, segment)) {
      continue;
    }

    const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
    const wordIndex = lookupWordIndex(clipId, wordIndexes, timelineIndex);
    if (!wordIndex?.words?.length) {
      continue;
    }

    for (const range of collectFillerWordRanges(scene.sceneId, timelineIndex)) {
      if (hasFillerCut(segment, range.startWordId, range.endWordId)) {
        continue;
      }

      segment.cuts = [...(segment.cuts ?? []), {
        startWordId: range.startWordId,
        endWordId: range.endWordId,
        reason: "filler",
      }];
      appliedCuts += 1;
    }
  }

  return appliedCuts;
}
