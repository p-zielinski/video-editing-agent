import { resolveSegmentOutputDuration, resolveWordIndexForSegment } from "./build-output-timeline.js";

function cloneRecipe(recipe) {
  return structuredClone(recipe);
}

function mergeClipRegistry(partials) {
  const byId = new Map();
  for (const partial of partials) {
    for (const entry of partial.clipRegistry ?? []) {
      byId.set(entry.clipId, { ...byId.get(entry.clipId), ...entry });
    }
  }
  return [...byId.values()];
}

function mergeExcluded(partials, superPlan) {
  const seen = new Set();
  const merged = [];

  const pushUnique = (entry) => {
    const key = [
      entry.exclusionType,
      entry.clipId ?? "",
      entry.sceneId ?? "",
      entry.reason ?? "",
    ].join("|");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(entry);
  };

  for (const partial of partials) {
    for (const entry of partial.excluded ?? []) {
      pushUnique(entry);
    }
  }

  for (const clipId of superPlan.excludedClips ?? []) {
    pushUnique({
      exclusionType: "whole_clip",
      clipId,
      usableAsBroll: false,
      reason: "super_director_excluded",
    });
  }

  return merged;
}

function mergeCreativeMoments(partials, outputId, timeOffsetSec) {
  const merged = [];
  for (const partial of partials) {
    for (const moment of partial.creativeMoments ?? []) {
      if (moment.outputId && moment.outputId !== outputId) {
        continue;
      }
      merged.push({
        ...moment,
        outputId,
        outputStartSec: (moment.outputStartSec ?? 0) + timeOffsetSec,
        outputEndSec: (moment.outputEndSec ?? 0) + timeOffsetSec,
      });
    }
  }
  return merged;
}

function findMatchingOutput(partial, templateOutput) {
  return partial.outputs?.find((output) => output.outputId === templateOutput.outputId)
    ?? partial.outputs?.find((output) => output.format === templateOutput.format);
}

function retimeTextOverlays(overlays, offsetSec) {
  return (overlays ?? []).map((overlay) => ({
    ...overlay,
    outputStartSec: overlay.outputStartSec + offsetSec,
    outputEndSec: overlay.outputEndSec + offsetSec,
  }));
}

function retimeSubtitles(subtitles, offsetSec) {
  if (!subtitles) {
    return subtitles;
  }
  const retimed = { ...subtitles };
  if (subtitles.outputStartSec != null) {
    retimed.outputStartSec = subtitles.outputStartSec + offsetSec;
  }
  if (subtitles.outputEndSec != null) {
    retimed.outputEndSec = subtitles.outputEndSec + offsetSec;
  }
  return retimed;
}

function computePartialTimelineOffsets(
  orderedPartials,
  templateOutput,
  wordIndexes,
  excludedClipIds,
) {
  const offsets = new Map();
  let cursor = 0;

  for (let i = 0; i < orderedPartials.length; i++) {
    const partial = orderedPartials[i];
    offsets.set(partial.segmentId ?? i, cursor);

    const partialOutput = findMatchingOutput(partial, templateOutput);
    if (!partialOutput?.timeline?.length) {
      continue;
    }

    for (const segment of partialOutput.timeline) {
      if (isExcludedTimelineSegment(segment, excludedClipIds)) {
        continue;
      }
      const wordIndex = resolveWordIndexForSegment(segment, wordIndexes);
      cursor += resolveSegmentOutputDuration(segment, { wordIndex });
    }
  }

  return offsets;
}

function resolveOrderedPartials(superPlan, partials) {
  const partialBySegmentId = new Map();
  for (const partial of partials) {
    if (partial.segmentId) {
      partialBySegmentId.set(partial.segmentId, partial);
    }
  }

  const segmentOrder = superPlan.segmentOrder?.length
    ? [...superPlan.segmentOrder]
    : (superPlan.segmentPicks ?? []).map((pick) => pick.segmentId);

  const appendIfMissing = (segmentId) => {
    if (segmentId && !segmentOrder.includes(segmentId) && partialBySegmentId.has(segmentId)) {
      segmentOrder.push(segmentId);
    }
  };

  for (const pick of superPlan.segmentPicks ?? []) {
    appendIfMissing(pick.segmentId);
  }
  for (const partial of partials) {
    appendIfMissing(partial.segmentId);
  }

  const ordered = segmentOrder
    .map((segmentId) => partialBySegmentId.get(segmentId))
    .filter(Boolean);

  return ordered.length > 0 ? ordered : partials;
}

function collectUnionOutputs(partials) {
  const byOutputId = new Map();
  for (const partial of partials) {
    for (const output of partial.outputs ?? []) {
      if (!byOutputId.has(output.outputId)) {
        byOutputId.set(output.outputId, { ...output, timeline: [] });
      }
    }
  }
  return [...byOutputId.values()];
}

function resolveMainOutputId(outputs) {
  return outputs?.find((output) => output.outputKind === "main")?.outputId
    ?? outputs?.[0]?.outputId;
}

function isExcludedTimelineSegment(segment, excludedClipIds) {
  if (!excludedClipIds?.size) {
    return false;
  }
  const videoClipId = segment.videoRef?.clipId;
  const audioClipId = segment.audioRef?.clipId;
  return (videoClipId && excludedClipIds.has(videoClipId))
    || (audioClipId && excludedClipIds.has(audioClipId));
}

function mergeSfxPlan(partials, outputId, mainOutputId, outputTimelineOffsets) {
  const merged = [];

  for (let i = 0; i < partials.length; i++) {
    const partial = partials[i];
    const offset = outputTimelineOffsets.get(partial.segmentId ?? i) ?? 0;

    for (const entry of partial.sfxPlan ?? []) {
      const entryOutputId = entry.outputId ?? mainOutputId;
      if (entryOutputId !== outputId) {
        continue;
      }
      merged.push({
        ...entry,
        outputStartSec: entry.outputStartSec + offset,
        outputEndSec: entry.outputEndSec + offset,
      });
    }
  }

  return merged;
}

function stitchOutputTimeline(orderedPartials, templateOutput, wordIndexes, excludedClipIds) {
  const mergedTimeline = [];
  const mergedMoments = [];
  let cursor = 0;

  for (const partial of orderedPartials) {
    const partialOutput = findMatchingOutput(partial, templateOutput);
    if (!partialOutput?.timeline?.length) {
      continue;
    }

    const partialOffset = cursor;
    for (const segment of partialOutput.timeline) {
      if (isExcludedTimelineSegment(segment, excludedClipIds)) {
        continue;
      }
      const wordIndex = resolveWordIndexForSegment(segment, wordIndexes);
      const duration = resolveSegmentOutputDuration(segment, { wordIndex });
      const overlap = segment.overlapSec ?? 0;
      const stitched = {
        ...segment,
        outputStartSec: cursor,
        outputEndSec: cursor + duration,
        textOverlays: retimeTextOverlays(segment.textOverlays, partialOffset),
        subtitles: retimeSubtitles(segment.subtitles, partialOffset),
      };
      mergedTimeline.push(stitched);

      if (segment.audioPolicy === "from_prev" && overlap > 0 && mergedTimeline.length > 1) {
        const prev = mergedTimeline[mergedTimeline.length - 2];
        prev.outputEndSec = cursor + overlap;
      }

      cursor += duration;
    }

    mergedMoments.push(
      ...mergeCreativeMoments([partial], templateOutput.outputId, partialOffset),
    );
  }

  return { timeline: mergedTimeline, creativeMoments: mergedMoments };
}

/**
 * Deterministically merge partial segment-director recipes into one EditRecipeV2-compatible object.
 */
export function mergeSegmentRecipes(superPlan, partials, options = {}) {
  if (!partials?.length) {
    throw new Error("mergeSegmentRecipes: brak częściowych receptur");
  }

  const { wordIndexes } = options;

  const effectivePartials = resolveOrderedPartials(superPlan, partials);
  const base = cloneRecipe(effectivePartials[0]);
  const allCreativeMoments = [];
  const excludedClipIds = new Set(superPlan.excludedClips ?? []);
  const templateOutputs = collectUnionOutputs(effectivePartials);

  base.outputs = templateOutputs.map((templateOutput) => {
    const stitched = stitchOutputTimeline(
      effectivePartials,
      templateOutput,
      wordIndexes,
      excludedClipIds,
    );
    allCreativeMoments.push(...stitched.creativeMoments);
    return {
      ...templateOutput,
      timeline: stitched.timeline,
    };
  });

  base.creativeMoments = allCreativeMoments;
  base.excluded = mergeExcluded(effectivePartials, superPlan);
  base.clipRegistry = mergeClipRegistry(effectivePartials);

  const mainOutputId = resolveMainOutputId(base.outputs);
  const mergedSfx = [];
  for (const templateOutput of base.outputs ?? []) {
    const outputTimelineOffsets = computePartialTimelineOffsets(
      effectivePartials,
      templateOutput,
      wordIndexes,
      excludedClipIds,
    );
    mergedSfx.push(
      ...mergeSfxPlan(
        effectivePartials,
        templateOutput.outputId,
        mainOutputId,
        outputTimelineOffsets,
      ),
    );
  }
  base.sfxPlan = mergedSfx;

  if (superPlan.globalTheme) {
    base.batchContext = {
      ...base.batchContext,
      theme: superPlan.globalTheme,
    };
  }
  if (superPlan.creativityProfile) {
    base.creativityProfile = {
      ...base.creativityProfile,
      ...superPlan.creativityProfile,
    };
  }
  if (superPlan.narrativeProfile) {
    base.narrativeProfile = superPlan.narrativeProfile;
  }
  if (superPlan.crossSegmentCallbacks?.length) {
    base.structuredCallbacks = superPlan.crossSegmentCallbacks;
  }

  return base;
}
