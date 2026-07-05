/**
 * Bridge montage hints for L2 segments not picked by super-director.
 * Inserts short crossfade bridge creativeMoments between picked segments.
 */

const BRIDGE_CROSSFADE_SEC = 0.35;
const BRIDGE_MOMENT_DURATION_SEC = 0.4;
const MAX_BRIDGE_MOMENTS = 4;

function resolvePickedSegmentIds(superPlan) {
  const order = superPlan?.segmentOrder?.length
    ? superPlan.segmentOrder
    : (superPlan?.segmentPicks ?? []).map((pick) => pick.segmentId);
  return new Set(order.filter(Boolean));
}

function findUnpickedL2BetweenPicks(abstraction, pickedIds, segmentOrder) {
  const l2 = abstraction?.L2 ?? [];
  if (l2.length === 0 || pickedIds.size === 0) {
    return [];
  }

  const orderedPicked = segmentOrder.filter((id) => pickedIds.has(id));
  const unpicked = [];

  for (let i = 0; i < orderedPicked.length - 1; i += 1) {
    const currentId = orderedPicked[i];
    const nextId = orderedPicked[i + 1];
    const currentIdx = l2.findIndex((seg) => seg.segmentId === currentId);
    const nextIdx = l2.findIndex((seg) => seg.segmentId === nextId);
    if (currentIdx < 0 || nextIdx < 0 || nextIdx <= currentIdx + 1) {
      continue;
    }

    for (let j = currentIdx + 1; j < nextIdx; j += 1) {
      const segment = l2[j];
      if (!pickedIds.has(segment.segmentId)) {
        unpicked.push({
          segmentId: segment.segmentId,
          afterSegmentId: currentId,
          beforeSegmentId: nextId,
          summary: segment.summary ?? "",
        });
      }
    }
  }

  return unpicked;
}

function findMainOutput(recipe) {
  return recipe.outputs?.find((output) => output.outputKind === "main" || output.format === "16:9")
    ?? recipe.outputs?.[0]
    ?? null;
}

function findJoinOutputSec(timeline, afterSegmentId, segmentOrder = []) {
  for (const segment of timeline) {
    const start = segment.outputStartSec ?? 0;
    const end = segment.outputEndSec ?? start;
    if (segment.segmentId === afterSegmentId || segment.l2SegmentId === afterSegmentId) {
      return end;
    }
  }

  const pickIdx = segmentOrder.indexOf(afterSegmentId);
  if (pickIdx >= 0 && pickIdx < timeline.length) {
    const segment = timeline[pickIdx];
    return segment?.outputEndSec ?? null;
  }

  return null;
}

/**
 * Add bridge crossfade moments and metadata for unpicked L2 gaps.
 * @returns {object} recipe (mutated) with bridgeMontageHints
 */
export function enrichUnpickedL2Bridges(recipe, { abstraction, superPlan }) {
  if (!superPlan || !abstraction?.L2?.length) {
    return recipe;
  }

  const pickedIds = resolvePickedSegmentIds(superPlan);
  const segmentOrder = superPlan.segmentOrder?.length
    ? superPlan.segmentOrder
    : (superPlan.segmentPicks ?? []).map((pick) => pick.segmentId);

  const gaps = findUnpickedL2BetweenPicks(abstraction, pickedIds, segmentOrder);
  if (gaps.length === 0) {
    return recipe;
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput?.timeline?.length) {
    return recipe;
  }

  const bridgeHints = [];
  const newMoments = [...(recipe.creativeMoments ?? [])];
  let added = 0;

  for (const gap of gaps) {
    if (added >= MAX_BRIDGE_MOMENTS) {
      break;
    }

    const joinSec = findJoinOutputSec(mainOutput.timeline, gap.afterSegmentId, segmentOrder);
    if (joinSec == null) {
      continue;
    }

    const momentId = `bridge_${gap.segmentId}`;
    const already = newMoments.some((m) => m.momentId === momentId);
    if (already) {
      continue;
    }

    newMoments.push({
      momentId,
      techniqueId: "crossfade",
      outputId: mainOutput.outputId,
      outputStartSec: Math.round(joinSec * 10) / 10,
      outputEndSec: Math.round((joinSec + BRIDGE_MOMENT_DURATION_SEC) * 10) / 10,
      params: {
        durationSec: BRIDGE_CROSSFADE_SEC,
        bridgeFromL2: gap.segmentId,
        bridgeSummary: gap.summary.slice(0, 120),
      },
      intent: `Bridge montage dla pominiętego L2 ${gap.segmentId}`,
      enrichSource: "bridge_enrich",
    });

    bridgeHints.push({
      unpickedL2SegmentId: gap.segmentId,
      afterSegmentId: gap.afterSegmentId,
      beforeSegmentId: gap.beforeSegmentId,
      targetOutputSec: joinSec,
      style: "crossfade_bridge",
    });
    added += 1;
  }

  if (bridgeHints.length > 0) {
    recipe.bridgeMontageHints = [
      ...(recipe.bridgeMontageHints ?? []),
      ...bridgeHints,
    ];
    recipe.creativeMoments = newMoments;
  }

  return recipe;
}
