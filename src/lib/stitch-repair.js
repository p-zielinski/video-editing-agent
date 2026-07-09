import { enrichUnpickedL2Bridges } from "../editorial/bridge-enrich.js";
import {
  validateStitchContinuity,
  STITCH_EMPTY_TIMELINE,
  STITCH_DUPLICATE_SEGMENT_ID,
  STITCH_PARTIAL_GAP,
  STITCH_SEGMENT_MISSING,
} from "../validators/stitch-continuity.js";
import { resolveOrderedPartials } from "./recipe-merge.js";

const PARTIAL_GAP_WARN_SEC = 5;
const THIN_BRIDGE_DURATION_SEC = 3;

function findMainOutput(recipe) {
  return recipe.outputs?.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  ) ?? recipe.outputs?.[0] ?? null;
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

function dedupeTimelineSegmentIds(timeline) {
  const seen = new Map();
  for (const segment of timeline) {
    if (!segment.segmentId) {
      continue;
    }
    const count = (seen.get(segment.segmentId) ?? 0) + 1;
    seen.set(segment.segmentId, count);
    if (count > 1) {
      segment.segmentId = `${segment.segmentId}_repair${count}`;
    }
  }
}

function buildThinBridgeSegment(sceneId, clipId, segmentId) {
  return {
    segmentId,
    segmentRole: "bridge",
    videoRef: { clipId, sceneId },
    audioRef: { clipId, sceneId },
    videoInSec: 0,
    videoOutSec: THIN_BRIDGE_DURATION_SEC,
    audioInSec: 0,
    audioOutSec: THIN_BRIDGE_DURATION_SEC,
    audioPolicy: "from_video_ref",
    enrichSource: "stitch_repair",
  };
}

function resolveBridgeSceneForGap(fromSegmentId, toSegmentId, abstraction, superPlan) {
  const l2 = abstraction?.L2 ?? [];
  const fromIdx = l2.findIndex((entry) => entry.segmentId === fromSegmentId);
  const toIdx = l2.findIndex((entry) => entry.segmentId === toSegmentId);

  if (fromIdx >= 0 && toIdx > fromIdx + 1) {
    for (let i = fromIdx + 1; i < toIdx; i += 1) {
      const sceneId = l2[i]?.sceneIds?.[0];
      if (sceneId) {
        return { sceneId, l2SegmentId: l2[i].segmentId };
      }
    }
  }

  const toPick = (superPlan?.segmentPicks ?? []).find((pick) => pick.segmentId === toSegmentId);
  const sceneIds = resolvePickSceneIds(toPick ?? { segmentId: toSegmentId }, abstraction);
  if (sceneIds[0]) {
    return { sceneId: sceneIds[0], l2SegmentId: toSegmentId };
  }

  return null;
}

function insertBridgeForGap(timeline, insertIndex, bridgeScene, clipId) {
  const bridgeId = `stitch_bridge_${bridgeScene.l2SegmentId}`;
  const bridge = buildThinBridgeSegment(bridgeScene.sceneId, clipId, bridgeId);
  timeline.splice(insertIndex, 0, bridge);
  return bridge;
}

function resolveSceneClipId(sceneId, timelineIndex) {
  const scene = (timelineIndex?.scenes ?? []).find((entry) => entry.sceneId === sceneId);
  return scene?.clipId ?? null;
}

function repairPartialGaps(recipe, {
  superPlan,
  abstraction,
  partials,
  wordIndexes,
  timelineIndex = null,
}) {
  if (!superPlan || partials.length <= 1) {
    return;
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput?.timeline?.length) {
    return;
  }

  const gapIssues = validateStitchContinuity(recipe, {
    superPlan,
    abstraction,
    partials,
    wordIndexes,
  }).filter((issue) => issue.code === STITCH_PARTIAL_GAP);

  if (gapIssues.length === 0) {
    return;
  }

  enrichUnpickedL2Bridges(recipe, { abstraction, superPlan });

  const orderedPartials = resolveOrderedPartials(superPlan, partials);
  const timeline = mainOutput.timeline;

  for (const issue of gapIssues) {
    const bridgeScene = resolveBridgeSceneForGap(
      issue.fromSegmentId,
      issue.toSegmentId,
      abstraction,
      superPlan,
    );
    if (!bridgeScene) {
      continue;
    }

    const clipId = resolveSceneClipId(bridgeScene.sceneId, timelineIndex);
    if (!clipId) {
      continue;
    }

    const toPartialIdx = orderedPartials.findIndex(
      (partial) => partial.segmentId === issue.toSegmentId,
    );
    if (toPartialIdx <= 0) {
      continue;
    }

    let insertIndex = timeline.length;
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const segment = timeline[i];
      if (
        segment.segmentId === issue.fromSegmentId
        || segment.l2SegmentId === issue.fromSegmentId
      ) {
        insertIndex = i + 1;
        break;
      }
    }

    const alreadyBridged = timeline.some(
      (segment) => segment.segmentId === `stitch_bridge_${bridgeScene.l2SegmentId}`,
    );
    if (!alreadyBridged) {
      insertBridgeForGap(timeline, insertIndex, bridgeScene, clipId);
    }
  }
}

function repairMissingSegments(recipe, { superPlan, abstraction, timelineIndex = null }) {
  const mainOutput = findMainOutput(recipe);
  if (!mainOutput?.timeline) {
    return;
  }

  const timeline = mainOutput.timeline;
  const representedScenes = new Set(
    timeline.flatMap((segment) => [
      segment.videoRef?.sceneId,
      segment.audioRef?.sceneId,
    ].filter(Boolean)),
  );

  for (const pick of superPlan?.segmentPicks ?? []) {
    const sceneIds = resolvePickSceneIds(pick, abstraction);
    const represented = sceneIds.some((sceneId) => representedScenes.has(sceneId));
    if (represented || !sceneIds[0]) {
      continue;
    }

    const clipId = resolveSceneClipId(sceneIds[0], timelineIndex);
    if (!clipId) {
      continue;
    }

    timeline.push(buildThinBridgeSegment(
      sceneIds[0],
      clipId,
      `stitch_missing_${pick.segmentId}`,
    ));
    representedScenes.add(sceneIds[0]);
  }
}

/**
 * Deterministic single-pass repair for common stitch continuity issues.
 *
 * @returns {{ repaired: boolean, recipe: object, unfixable: boolean }}
 */
export function repairStitchContinuity(recipe, {
  superPlan = null,
  abstraction = null,
  partials = [],
  wordIndexes = null,
  timelineIndex = null,
} = {}) {
  const mainOutput = findMainOutput(recipe);
  const timeline = mainOutput?.timeline ?? [];

  if (!timeline.length) {
    return { repaired: false, recipe, unfixable: true };
  }

  let repaired = false;

  const duplicateIssues = validateStitchContinuity(recipe, {
    superPlan,
    abstraction,
    partials,
    wordIndexes,
  }).filter((issue) => issue.code === STITCH_DUPLICATE_SEGMENT_ID);

  if (duplicateIssues.length > 0) {
    dedupeTimelineSegmentIds(timeline);
    repaired = true;
  }

  const missingIssues = validateStitchContinuity(recipe, {
    superPlan,
    abstraction,
    partials,
    wordIndexes,
  }).filter((issue) => issue.code === STITCH_SEGMENT_MISSING);

  if (missingIssues.length > 0) {
    repairMissingSegments(recipe, { superPlan, abstraction, timelineIndex });
    repaired = true;
  }

  const gapIssues = validateStitchContinuity(recipe, {
    superPlan,
    abstraction,
    partials,
    wordIndexes,
  }).filter((issue) => issue.code === STITCH_PARTIAL_GAP && issue.gapSec > PARTIAL_GAP_WARN_SEC);

  if (gapIssues.length > 0) {
    repairPartialGaps(recipe, {
      superPlan,
      abstraction,
      partials,
      wordIndexes,
      timelineIndex,
    });
    repaired = true;
  }

  const stillEmpty = !findMainOutput(recipe)?.timeline?.length;
  if (stillEmpty) {
    return { repaired, recipe, unfixable: true };
  }

  const emptyCheck = validateStitchContinuity(recipe, {
    superPlan,
    abstraction,
    partials,
    wordIndexes,
  }).some((issue) => issue.code === STITCH_EMPTY_TIMELINE);

  return {
    repaired,
    recipe,
    unfixable: emptyCheck,
  };
}
