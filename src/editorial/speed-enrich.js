import { buildOutputTimeline, resolveWordIndexForSegment } from "../lib/build-output-timeline.js";
import {
  findL2SegmentIdForSourceTime,
  isSlowBreathNarrativeSegment,
  resolveL2OutputRangeSec,
  resolveL2SegmentProfile,
  resolveRecipeNarrativeProfile,
  shouldPreserveSilenceForSegment,
} from "../lib/narrative-profile.js";

export const MAX_FAST_RHYTHM_SPEED_SEGMENTS = 3;
const DEFAULT_SPEED = 1.5;
const SPEECH_BOUNDARY_TOLERANCE_SEC = 0.05;

function findMainOutput(outputs = []) {
  return outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function isBrollPoolClip(clipId, clipRegistry = []) {
  const entry = clipRegistry.find((clip) => clip.clipId === clipId);
  return entry?.clipRole === "broll_pool";
}

function isBrollSegment(segment, clipRegistry = []) {
  if (segment.segmentRole === "broll") {
    return true;
  }
  const videoClipId = segment.videoRef?.clipId;
  return videoClipId ? isBrollPoolClip(videoClipId, clipRegistry) : false;
}

function hasSpeedAlreadySet(segment) {
  const speed = segment.videoTransform?.speed;
  return speed != null && speed !== 1;
}

function hasSpeechWordsInVideoRange(segment, wordIndexes) {
  const clipId = segment.videoRef?.clipId;
  if (!clipId) {
    return false;
  }

  const videoIn = segment.videoInSec ?? 0;
  const videoOut = segment.videoOutSec ?? videoIn;
  const wordIndex = resolveWordIndexForSegment(
    { ...segment, audioRef: { clipId } },
    wordIndexes,
  );
  if (!wordIndex?.words?.length) {
    return false;
  }

  for (const word of wordIndex.words) {
    const interiorStart = word.start + SPEECH_BOUNDARY_TOLERANCE_SEC;
    const interiorEnd = word.end - SPEECH_BOUNDARY_TOLERANCE_SEC;
    if (interiorEnd <= interiorStart) {
      continue;
    }
    if (videoIn < interiorEnd && videoOut > interiorStart) {
      return true;
    }
  }
  return false;
}

function isFastTensionL2Segment(l2Segment, narrativeProfile) {
  const segmentProfile = resolveL2SegmentProfile(narrativeProfile, l2Segment.segmentId);
  if (isSlowBreathNarrativeSegment(segmentProfile, l2Segment)) {
    return false;
  }
  if (shouldPreserveSilenceForSegment(narrativeProfile, l2Segment.segmentId)) {
    return false;
  }
  if (segmentProfile?.rhythm === "fast") {
    return true;
  }
  return l2Segment.narrativeRole === "tension";
}

function segmentOverlapsOutputRange(segment, range) {
  const start = segment.outputStartSec ?? 0;
  const end = segment.outputEndSec ?? start;
  return start < range.endSec && end > range.startSec;
}

function resolveSpeedForIntensity(retentionIntensity) {
  if (retentionIntensity === "high") {
    return 2.0;
  }
  if (retentionIntensity === "low") {
    return 1.25;
  }
  return DEFAULT_SPEED;
}

function resolveRetentionIntensity(l2Segment, segmentProfile) {
  if (segmentProfile?.retentionIntensity) {
    return segmentProfile.retentionIntensity;
  }
  if (l2Segment.narrativeRole === "tension") {
    return "high";
  }
  return "medium";
}

function resolveFastL2Ranges(recipe, abstraction, mainOutput, narrativeProfile, wordIndexes) {
  const ranges = [];
  for (const l2Segment of abstraction?.L2 ?? []) {
    if (!isFastTensionL2Segment(l2Segment, narrativeProfile)) {
      continue;
    }
    const range = resolveL2OutputRangeSec(
      l2Segment.segmentId,
      abstraction,
      recipe,
      mainOutput,
      wordIndexes,
    );
    if (!range) {
      continue;
    }
    ranges.push({
      l2Segment,
      range,
      segmentProfile: resolveL2SegmentProfile(narrativeProfile, l2Segment.segmentId),
    });
  }
  return ranges;
}

function segmentMatchesFastL2(enrichedSegment, fastL2Ranges, abstraction, timelineIndex) {
  for (const entry of fastL2Ranges) {
    if (segmentOverlapsOutputRange(enrichedSegment, entry.range)) {
      return entry;
    }
  }

  const clipId = enrichedSegment.videoRef?.clipId ?? enrichedSegment.audioRef?.clipId;
  const sourceIn = enrichedSegment.videoInSec ?? enrichedSegment.audioInSec ?? 0;
  const sourceMid = sourceIn + (
    ((enrichedSegment.videoOutSec ?? sourceIn) - sourceIn) / 2
  );
  const l2SegmentId = findL2SegmentIdForSourceTime(
    abstraction,
    timelineIndex,
    clipId,
    sourceMid,
  );
  if (!l2SegmentId) {
    return null;
  }

  return fastL2Ranges.find((entry) => entry.l2Segment.segmentId === l2SegmentId) ?? null;
}

/**
 * Speed up silent B-roll in fast/tension L2 spans for tension montage pacing.
 *
 * @param {object} recipe - EditRecipe v2 draft (mutated in place)
 * @param {{ abstraction?: object, timelineIndex?: object, wordIndexes?: object[] }} [options]
 * @returns {object} recipe
 */
export function enrichRecipeFastRhythmSpeed(recipe, {
  abstraction,
  timelineIndex,
  wordIndexes = null,
} = {}) {
  const mainOutput = findMainOutput(recipe?.outputs ?? []);
  if (!mainOutput?.timeline?.length || !abstraction?.L2?.length) {
    return recipe;
  }

  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const clipRegistry = recipe?.clipRegistry ?? [];
  const fastL2Ranges = resolveFastL2Ranges(
    recipe,
    abstraction,
    mainOutput,
    narrativeProfile,
    wordIndexes,
  );
  if (!fastL2Ranges.length) {
    return recipe;
  }

  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  let modified = 0;

  for (let i = 0; i < mainOutput.timeline.length; i += 1) {
    if (modified >= MAX_FAST_RHYTHM_SPEED_SEGMENTS) {
      break;
    }

    const segment = mainOutput.timeline[i];
    const enriched = enrichedTimeline[i];
    if (!segment || !enriched) {
      continue;
    }

    const matchingL2 = segmentMatchesFastL2(
      enriched,
      fastL2Ranges,
      abstraction,
      timelineIndex,
    );
    if (!matchingL2) {
      continue;
    }
    if (!isBrollSegment(segment, clipRegistry)) {
      continue;
    }
    if (hasSpeedAlreadySet(segment)) {
      continue;
    }
    if (hasSpeechWordsInVideoRange(segment, wordIndexes)) {
      continue;
    }

    const speed = resolveSpeedForIntensity(
      resolveRetentionIntensity(matchingL2.l2Segment, matchingL2.segmentProfile),
    );
    segment.videoTransform = {
      ...(segment.videoTransform ?? {}),
      speed,
      speedMode: "video_only",
    };
    modified += 1;
  }

  return recipe;
}
