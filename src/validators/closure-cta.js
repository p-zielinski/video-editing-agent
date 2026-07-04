import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import {
  resolveL2SegmentProfile,
  resolveRecipeNarrativeProfile,
} from "../lib/narrative-profile.js";
import { resolveMainOutputDurationSec } from "../editorial/shorts-retention.js";

export const CLOSURE_CTA_VALIDATOR_CODE = "V26-CTA-01";
const CTA_MIN_DURATION_SEC = 60;
const CTA_TAIL_CHECK_SEC = 15;

function findMainOutput(outputs = []) {
  return outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function resolveFinalL2Segment(abstraction) {
  const segments = abstraction?.L2 ?? [];
  if (!segments.length) {
    return null;
  }

  let best = segments[segments.length - 1];
  for (const segment of segments) {
    const end = segment.endSec ?? 0;
    const bestEnd = best.endSec ?? 0;
    if (end >= bestEnd) {
      best = segment;
    }
  }
  return best;
}

function shouldApplyClosureCta(recipe, abstraction) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (narrativeProfile?.mode === "internet_documentary") {
    return true;
  }
  const finalL2 = resolveFinalL2Segment(abstraction);
  return finalL2?.narrativeRole === "resolution";
}

function shouldSkipDueToFinalSegmentRetention(recipe, abstraction) {
  const finalL2 = resolveFinalL2Segment(abstraction);
  if (!finalL2) {
    return false;
  }

  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const segmentProfile = resolveL2SegmentProfile(narrativeProfile, finalL2.segmentId);
  if (segmentProfile?.retentionIntensity === "high") {
    return true;
  }

  if (!segmentProfile?.retentionIntensity && finalL2.narrativeRole === "tension") {
    return true;
  }

  return false;
}

function collectTextOverlays(segments) {
  const overlays = [];
  for (const segment of segments) {
    for (const overlay of segment.textOverlays ?? []) {
      overlays.push(overlay);
    }
  }
  return overlays;
}

function hasCtaInTail(overlays, durationSec, toleranceSec = CTA_TAIL_CHECK_SEC) {
  const tailStart = durationSec - toleranceSec;
  return overlays.some(
    (overlay) => overlay.role === "cta" && (overlay.outputStartSec ?? 0) >= tailStart,
  );
}

/**
 * Warn when documentary/resolution closure expects a CTA but main lacks one in the last 15s.
 * Mirrors `enrichRecipeClosureCta` eligibility rules.
 *
 * @param {object} recipe
 * @param {{ abstraction?: object, wordIndexes?: object[] }} [options]
 */
export function validateClosureCta(recipe, { abstraction, wordIndexes } = {}) {
  const mainOutput = findMainOutput(recipe.outputs ?? []);
  if (!mainOutput) {
    return [];
  }

  const durationSec = resolveMainOutputDurationSec({
    outputs: recipe.outputs ?? [],
    batchContext: recipe.batchContext ?? {},
  });
  if (durationSec < CTA_MIN_DURATION_SEC) {
    return [];
  }

  if (!shouldApplyClosureCta(recipe, abstraction)) {
    return [];
  }

  if (shouldSkipDueToFinalSegmentRetention(recipe, abstraction)) {
    return [];
  }

  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  const overlays = collectTextOverlays(enrichedTimeline);
  if (hasCtaInTail(overlays, durationSec)) {
    return [];
  }

  return [{
    severity: "warning",
    code: CLOSURE_CTA_VALIDATOR_CODE,
    message: `Main >=${CTA_MIN_DURATION_SEC}s (documentary/resolution) bez overlay CTA w ostatnich ${CTA_TAIL_CHECK_SEC}s`,
    outputId: mainOutput.outputId,
  }];
}
