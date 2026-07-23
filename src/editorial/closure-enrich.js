import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import {
  resolveL2SegmentProfile,
  resolveRecipeNarrativeProfile,
} from "../lib/narrative-profile.js";
import { resolveMainOutputDurationSec } from "./shorts-retention.js";

export const CLOSURE_CTA_OVERLAY_ID = "enrich_cta_001";

const CTA_MIN_DURATION_SEC = 60;
const CTA_TAIL_CHECK_SEC = 15;
const CTA_WINDOW_SEC = 10;
const CTA_DEFAULT_TEXT = "Subskrybuj";
const CTA_TEXT_MAX_CHARS = 24;

function truncateText(text, maxLen) {
  const s = String(text ?? "").trim();
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, maxLen - 1)}…`;
}

function findMainOutput(outputs = []) {
  return outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function findMainOutputIndex(outputs = []) {
  return outputs.findIndex(
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
  for (const seg of segments) {
    for (const overlay of seg.textOverlays ?? []) {
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

function hasTailOverlayConflict(overlays, durationSec, toleranceSec = CTA_TAIL_CHECK_SEC) {
  const tailStart = durationSec - toleranceSec;
  return overlays.some((overlay) => {
    if ((overlay.outputStartSec ?? 0) < tailStart) {
      return false;
    }
    const role = overlay.role;
    if (role === "payoff" || role === "closure" || role === "cta") {
      return true;
    }
    return overlay.style === "emphasis";
  });
}

function findSegmentForOutputSec(segments, outputSec) {
  return segments.find(
    (seg) => outputSec >= seg.outputStartSec && outputSec < seg.outputEndSec,
  ) ?? segments[segments.length - 1];
}

function resolveCtaText(_abstraction) {
  void _abstraction;
  return truncateText(CTA_DEFAULT_TEXT, CTA_TEXT_MAX_CHARS);
}

/**
 * Add a subtle CTA text overlay on the main output tail when documentary/resolution
 * closure is expected and the director did not place a CTA in the last 15s.
 *
 * @param {object} recipe - EditRecipe v2 draft (mutated in place)
 * @param {{ abstraction?: object }} [options]
 * @returns {object} recipe
 */
export function enrichRecipeClosureCta(recipe, { abstraction } = {}) {
  const outputs = recipe?.outputs ?? [];
  const mainOutputIndex = findMainOutputIndex(outputs);
  if (mainOutputIndex < 0) {
    return recipe;
  }

  const mainOutput = outputs[mainOutputIndex];
  const durationSec = resolveMainOutputDurationSec({
    outputs,
    batchContext: recipe.batchContext ?? {},
  });
  if (durationSec < CTA_MIN_DURATION_SEC) {
    return recipe;
  }

  if (!shouldApplyClosureCta(recipe, abstraction)) {
    return recipe;
  }

  if (shouldSkipDueToFinalSegmentRetention(recipe, abstraction)) {
    return recipe;
  }

  const enrichedTimeline = buildOutputTimeline(mainOutput);
  const existingOverlays = collectTextOverlays(enrichedTimeline);
  if (existingOverlays.some((overlay) => overlay.overlayId === CLOSURE_CTA_OVERLAY_ID)) {
    return recipe;
  }

  if (hasCtaInTail(existingOverlays, durationSec)) {
    return recipe;
  }

  if (hasTailOverlayConflict(existingOverlays, durationSec)) {
    return recipe;
  }

  const outputEndSec = Math.round(durationSec * 10) / 10;
  const outputStartSec = Math.max(
    0,
    Math.round((durationSec - CTA_WINDOW_SEC) * 10) / 10,
  );
  const resolvedSeg = findSegmentForOutputSec(enrichedTimeline, outputStartSec);
  if (!resolvedSeg) {
    return recipe;
  }

  const timeline = [...mainOutput.timeline];
  const segIdx = timeline.findIndex((seg) => seg.segmentId === resolvedSeg.segmentId);
  if (segIdx < 0) {
    return recipe;
  }

  const overlay = {
    overlayId: CLOSURE_CTA_OVERLAY_ID,
    text: resolveCtaText(abstraction),
    outputStartSec,
    outputEndSec,
    style: "cta",
    role: "cta",
  };

  const segment = timeline[segIdx];
  timeline[segIdx] = {
    ...segment,
    textOverlays: [...(segment.textOverlays ?? []), overlay],
  };

  recipe.outputs[mainOutputIndex] = {
    ...mainOutput,
    timeline,
  };

  return recipe;
}
