import {
  buildOutputTimeline,
  resolveSegmentOutputDuration,
  resolveWordIndexForSegment,
} from "../lib/build-output-timeline.js";
import { resolveOrderedPartials } from "../lib/recipe-merge.js";

export const STITCH_EMPTY_TIMELINE = "STITCH-EMPTY-01";
export const STITCH_SEGMENT_MISSING = "STITCH-SEGMENT-01";
export const STITCH_DUPLICATE_SEGMENT_ID = "STITCH-DUPLICATE-01";
export const STITCH_PARTIAL_GAP = "STITCH-GAP-01";

const PARTIAL_GAP_WARN_SEC = 5;

function findMainOutput(recipe) {
  return recipe.outputs?.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function resolvePickSceneIds(pick, abstraction) {
  if (pick.sceneIds?.length) {
    return pick.sceneIds;
  }

  const l2Segment = (abstraction?.L2 ?? []).find(
    (entry) => entry.segmentId === pick.segmentId,
  );
  return l2Segment?.sceneIds ?? [];
}

function timelineUsesScene(timeline, sceneId) {
  return (timeline ?? []).some(
    (segment) => segment.videoRef?.sceneId === sceneId
      || segment.audioRef?.sceneId === sceneId,
  );
}

function computePartialBoundarySec(orderedPartials, templateOutput, wordIndexes, excludedClipIds) {
  const boundaries = [];
  let cursor = 0;

  for (const partial of orderedPartials) {
    boundaries.push({ segmentId: partial.segmentId, startSec: cursor });

    const partialOutput = partial.outputs?.find(
      (output) => output.outputId === templateOutput.outputId
        || output.format === templateOutput.format,
    );
    if (!partialOutput?.timeline?.length) {
      continue;
    }

    let partialEnd = cursor;
    for (const segment of partialOutput.timeline) {
      const clipId = segment.videoRef?.clipId ?? segment.audioRef?.clipId;
      if (excludedClipIds?.has?.(clipId)) {
        continue;
      }
      const wordIndex = resolveWordIndexForSegment(segment, wordIndexes);
      partialEnd += resolveSegmentOutputDuration(segment, { wordIndex });
    }
    cursor = partialEnd;
    boundaries[boundaries.length - 1].endSec = cursor;
  }

  return boundaries;
}

/**
 * Post-merge stitch checks for super-director multi-L2 path.
 *
 * @param {object} recipe
 * @param {{ superPlan?: object, abstraction?: object, partials?: object[], wordIndexes?: object[] }} [options]
 */
export function validateStitchContinuity(recipe, {
  superPlan = null,
  abstraction = null,
  partials = [],
  wordIndexes = null,
} = {}) {
  const issues = [];
  const mainOutput = findMainOutput(recipe);
  const timeline = mainOutput?.timeline ?? [];

  if (!timeline.length) {
    issues.push({
      severity: "error",
      code: STITCH_EMPTY_TIMELINE,
      message: "Scalona receptura ma pusty timeline main",
      outputId: mainOutput?.outputId,
    });
    return issues;
  }

  const seenSegmentIds = new Map();
  for (const segment of timeline) {
    if (!segment.segmentId) {
      continue;
    }
    const count = (seenSegmentIds.get(segment.segmentId) ?? 0) + 1;
    seenSegmentIds.set(segment.segmentId, count);
    if (count > 1) {
      issues.push({
        severity: "error",
        code: STITCH_DUPLICATE_SEGMENT_ID,
        message: `Zduplikowany segmentId ${segment.segmentId} w scalonym timeline`,
        segmentId: segment.segmentId,
        outputId: mainOutput.outputId,
      });
    }
  }

  const picks = superPlan?.segmentPicks
    ?? (superPlan?.segmentOrder ?? []).map((segmentId) => ({ segmentId }));

  for (const pick of picks ?? []) {
    const sceneIds = resolvePickSceneIds(pick, abstraction);
    if (!sceneIds.length) {
      continue;
    }

    const represented = sceneIds.some((sceneId) => timelineUsesScene(timeline, sceneId));
    if (!represented) {
      issues.push({
        severity: "error",
        code: STITCH_SEGMENT_MISSING,
        message: `Segment L2 ${pick.segmentId} nie jest reprezentowany w scalonym timeline`,
        segmentId: pick.segmentId,
        outputId: mainOutput.outputId,
      });
    }
  }

  if (partials.length > 1 && mainOutput) {
    const excludedClipIds = new Set(superPlan?.excludedClips ?? []);
    const orderedPartials = superPlan
      ? resolveOrderedPartials(superPlan, partials)
      : partials;
    const boundaries = computePartialBoundarySec(
      orderedPartials,
      mainOutput,
      wordIndexes,
      excludedClipIds,
    );
    const enriched = buildOutputTimeline(mainOutput, { wordIndexes });

    for (let i = 1; i < boundaries.length; i += 1) {
      const prev = boundaries[i - 1];
      const current = boundaries[i];
      if (prev.endSec == null || current.startSec == null) {
        continue;
      }

      const gapSec = current.startSec - prev.endSec;
      if (gapSec <= PARTIAL_GAP_WARN_SEC) {
        continue;
      }

      const segmentBefore = [...enriched]
        .reverse()
        .find((entry) => (entry.outputEndSec ?? 0) <= prev.endSec + 0.05);
      const segmentAfter = enriched.find(
        (entry) => (entry.outputStartSec ?? 0) >= current.startSec - 0.05,
      );
      const outputGap = (segmentAfter?.outputStartSec ?? current.startSec)
        - (segmentBefore?.outputEndSec ?? prev.endSec);

      if (outputGap > PARTIAL_GAP_WARN_SEC) {
        issues.push({
          severity: "warning",
          code: STITCH_PARTIAL_GAP,
          message: `Luka ${outputGap.toFixed(1)}s między partial ${prev.segmentId} a ${current.segmentId}`,
          fromSegmentId: prev.segmentId,
          toSegmentId: current.segmentId,
          gapSec: Math.round(outputGap * 10) / 10,
        });
      }
    }
  }

  return issues;
}
