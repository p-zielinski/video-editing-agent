import { sanitizeRecipeConsistency } from "../editorial/recipe-consistency-sanitize.js";
import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import { DEFAULT_RENDER_STYLE_PRESETS } from "../render/style-presets.js";

const TIMELINE_TOLERANCE_SEC = 0.05;
const MIN_OVERLAY_DURATION_SEC = 0.3;

/**
 * @param {string|undefined|null} positionOrPlacement
 * @returns {"top"|"center"|"bottom"|null}
 */
export function normalizeLayoutBand(positionOrPlacement) {
  if (positionOrPlacement == null || positionOrPlacement === "") {
    return null;
  }

  const value = String(positionOrPlacement).toLowerCase();
  if (
    value === "bottom"
    || value === "bottom_center"
    || value === "bottom_third"
  ) {
    return "bottom";
  }
  if (value === "top" || value === "top_center") {
    return "top";
  }
  if (value === "center") {
    return "center";
  }
  return null;
}

/**
 * @param {object} segment
 * @returns {"top"|"center"|"bottom"|null}
 */
export function resolveSubtitleBand(segment) {
  const policy = segment?.subtitles?.policy ?? "off";
  if (policy === "off") {
    return null;
  }
  return normalizeLayoutBand(segment.subtitles?.placement) ?? "bottom";
}

/**
 * @param {object} overlay
 * @param {object} [stylePresets]
 * @returns {"top"|"center"|"bottom"}
 */
export function resolveOverlayBand(overlay, stylePresets = DEFAULT_RENDER_STYLE_PRESETS) {
  const fromPosition = normalizeLayoutBand(overlay?.position);
  if (fromPosition) {
    return fromPosition;
  }

  const styleKey = overlay?.style;
  if (styleKey) {
    const presetPosition = stylePresets?.overlays?.[styleKey]?.position
      ?? DEFAULT_RENDER_STYLE_PRESETS.overlays[styleKey]?.position;
    const fromPreset = normalizeLayoutBand(presetPosition);
    if (fromPreset) {
      return fromPreset;
    }
  }

  return "center";
}

function resolveOverlayRole(overlay) {
  if (overlay?.role) {
    return overlay.role;
  }
  const style = overlay?.style ?? "";
  if (style === "cta") {
    return "cta";
  }
  if (style === "chapter_card") {
    return "chapter";
  }
  if (style === "closure_bracket") {
    return "closure";
  }
  if (style.startsWith("hook_")) {
    return "hook";
  }
  if (style === "emphasis") {
    return "retention_beat";
  }
  return undefined;
}

/**
 * @param {object} overlay
 * @returns {number}
 */
export function overlayKeepScore(overlay) {
  const role = resolveOverlayRole(overlay);
  const roleScores = {
    payoff: 500,
    hook: 400,
    chapter: 300,
    retention_beat: 200,
    emphasis: 200,
    closure: 150,
    cta: 100,
  };

  let score = roleScores[role] ?? 100;

  const style = overlay?.style ?? "";
  if (style === "chapter_card") {
    score = Math.max(score, 300);
  }
  if (style.startsWith("hook_")) {
    score = Math.max(score, 400);
  }

  const overlayId = overlay?.overlayId ?? "";
  if (!overlayId.startsWith("enrich_")) {
    score += 50;
  }

  return score;
}

/**
 * Touching endpoints are not considered overlapping (a1 === b0 is OK).
 */
export function timeRangesOverlap(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

/**
 * @returns {number} intersection / min(durA, durB), or 0 when ranges do not overlap
 */
export function overlapCoverageRatio(a0, a1, b0, b1) {
  if (!timeRangesOverlap(a0, a1, b0, b1)) {
    return 0;
  }
  const intersection = Math.min(a1, b1) - Math.max(a0, b0);
  const durA = Math.max(0, a1 - a0);
  const durB = Math.max(0, b1 - b0);
  const minDur = Math.min(durA, durB);
  if (minDur <= 0) {
    return 0;
  }
  return intersection / minDur;
}

function normalizeOverlayText(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function resolveStylePresets(recipe, options) {
  return options.stylePresets
    ?? recipe.renderStylePresets
    ?? DEFAULT_RENDER_STYLE_PRESETS;
}

function resolveOutputSpan(enrichedTimeline) {
  if (!enrichedTimeline.length) {
    return { startSec: 0, endSec: 0 };
  }
  const startSec = enrichedTimeline[0].outputStartSec ?? 0;
  const last = enrichedTimeline[enrichedTimeline.length - 1];
  const endSec = last.outputEndSec ?? startSec;
  return { startSec, endSec };
}

function resolveSubtitleWindow(segment) {
  const segStart = segment.outputStartSec ?? 0;
  const segEnd = segment.outputEndSec ?? segStart;
  const startSec = segment.subtitles?.outputStartSec ?? segStart;
  const endSec = segment.subtitles?.outputEndSec ?? segEnd;
  return { startSec, endSec };
}

function isOutsideRange(startSec, endSec, boundsStart, boundsEnd, tolerance = 0.001) {
  return startSec < boundsStart - tolerance || endSec > boundsEnd + tolerance;
}

function collectSegmentOverlays(enrichedTimeline, outputId, stylePresets) {
  const overlays = [];
  for (const segment of enrichedTimeline) {
    for (const overlay of segment.textOverlays ?? []) {
      overlays.push({
        overlay,
        segment,
        outputId,
        band: resolveOverlayBand(overlay, stylePresets),
        startSec: overlay.outputStartSec ?? segment.outputStartSec ?? 0,
        endSec: overlay.outputEndSec ?? overlay.outputStartSec ?? 0,
      });
    }
  }
  return overlays;
}

function validateTimelineRanges(recipe, issues, options = {}) {
  const outputSpans = new Map();

  for (const output of recipe.outputs ?? []) {
    const enriched = buildOutputTimeline(output, { wordIndexes: options.wordIndexes });
    outputSpans.set(output.outputId, resolveOutputSpan(enriched));

    for (const segment of enriched) {
      if (
        segment.outputStartSec != null
        && segment.outputEndSec != null
        && segment.outputEndSec <= segment.outputStartSec
      ) {
        issues.push({
          severity: "error",
          code: "CONS-TL-01",
          message: `Segment ${segment.segmentId}: outputEndSec <= outputStartSec`,
          outputId: output.outputId,
          segmentId: segment.segmentId,
        });
      }

      for (const overlay of segment.textOverlays ?? []) {
        const startSec = overlay.outputStartSec ?? segment.outputStartSec ?? 0;
        const endSec = overlay.outputEndSec ?? startSec;
        if (endSec <= startSec) {
          issues.push({
            severity: "error",
            code: "CONS-TL-01",
            message: `Overlay ${overlay.overlayId ?? "?"}: outputEndSec <= outputStartSec`,
            outputId: output.outputId,
            segmentId: segment.segmentId,
            overlayId: overlay.overlayId,
          });
        }
      }

      if (segment.subtitles) {
        const { startSec, endSec } = resolveSubtitleWindow(segment);
        if (
          segment.subtitles.outputStartSec != null
          && segment.subtitles.outputEndSec != null
          && endSec <= startSec
        ) {
          issues.push({
            severity: "error",
            code: "CONS-TL-01",
            message: `Segment ${segment.segmentId}: subtitles outputEndSec <= outputStartSec`,
            outputId: output.outputId,
            segmentId: segment.segmentId,
          });
        }
      }
    }
  }

  for (const moment of recipe.creativeMoments ?? []) {
    if (moment.outputEndSec <= moment.outputStartSec) {
      issues.push({
        severity: "error",
        code: "CONS-TL-01",
        message: `Moment ${moment.momentId}: outputEndSec <= outputStartSec`,
        outputId: moment.outputId,
      });
    }
  }

  for (const entry of recipe.sfxPlan ?? []) {
    if (entry.outputEndSec <= entry.outputStartSec) {
      issues.push({
        severity: "error",
        code: "CONS-TL-01",
        message: `SFX ${entry.sfxId}: outputEndSec <= outputStartSec`,
      });
    }
  }

  if ((recipe.sfxPlan ?? []).length > 0 && outputSpans.size > 0) {
    let unionStart = Infinity;
    let unionEnd = -Infinity;
    for (const span of outputSpans.values()) {
      unionStart = Math.min(unionStart, span.startSec);
      unionEnd = Math.max(unionEnd, span.endSec);
    }
    for (const entry of recipe.sfxPlan ?? []) {
      if (isOutsideRange(entry.outputStartSec, entry.outputEndSec, unionStart, unionEnd)) {
        issues.push({
          severity: "error",
          code: "CONS-TL-03",
          message: `SFX ${entry.sfxId} outside output span`,
        });
      }
    }
  }
}

function validateSegmentContinuity(recipe, issues, options) {
  for (const output of recipe.outputs ?? []) {
    const enriched = buildOutputTimeline(output, { wordIndexes: options.wordIndexes });
    for (let i = 1; i < enriched.length; i += 1) {
      const prev = enriched[i - 1];
      const next = enriched[i];
      const prevEnd = prev.outputEndSec ?? 0;
      const nextStart = next.outputStartSec ?? 0;
      const overlapSec = next.overlapSec ?? 0;
      const gap = nextStart - prevEnd;

      if (gap > TIMELINE_TOLERANCE_SEC) {
        issues.push({
          severity: "warning",
          code: "CONS-TL-02",
          message: `Gap ${gap.toFixed(3)}s between ${prev.segmentId} and ${next.segmentId}`,
          outputId: output.outputId,
          segmentId: next.segmentId,
        });
      }

      const allowedOverlapStart = prevEnd - overlapSec - TIMELINE_TOLERANCE_SEC;
      if (nextStart < allowedOverlapStart) {
        issues.push({
          severity: "warning",
          code: "CONS-TL-02",
          message: `Excess overlap between ${prev.segmentId} and ${next.segmentId}`,
          outputId: output.outputId,
          segmentId: next.segmentId,
        });
      }
    }
  }
}

function validateOwnershipWindows(recipe, issues, stylePresets, options) {
  for (const output of recipe.outputs ?? []) {
    const enriched = buildOutputTimeline(output, { wordIndexes: options.wordIndexes });
    const outputSpan = resolveOutputSpan(enriched);

    for (const segment of enriched) {
      const segStart = segment.outputStartSec ?? 0;
      const segEnd = segment.outputEndSec ?? segStart;

      for (const overlay of segment.textOverlays ?? []) {
        const startSec = overlay.outputStartSec ?? segStart;
        const endSec = overlay.outputEndSec ?? startSec;
        const boundsStart = segment.outputStartSec != null ? segStart : outputSpan.startSec;
        const boundsEnd = segment.outputEndSec != null ? segEnd : outputSpan.endSec;
        if (isOutsideRange(startSec, endSec, boundsStart, boundsEnd)) {
          issues.push({
            severity: "error",
            code: "CONS-TL-03",
            message: `Overlay ${overlay.overlayId ?? "?"} outside segment/output bounds`,
            outputId: output.outputId,
            segmentId: segment.segmentId,
            overlayId: overlay.overlayId,
          });
        }
      }

      if (segment.subtitles?.policy && segment.subtitles.policy !== "off") {
        const { startSec, endSec } = resolveSubtitleWindow(segment);
        if (isOutsideRange(startSec, endSec, segStart, segEnd)) {
          issues.push({
            severity: "error",
            code: "CONS-TL-03",
            message: `Subtitles on ${segment.segmentId} outside segment bounds`,
            outputId: output.outputId,
            segmentId: segment.segmentId,
          });
        }
      }
    }

    for (const moment of recipe.creativeMoments ?? []) {
      if (moment.outputId && moment.outputId !== output.outputId) {
        continue;
      }
      if (
        isOutsideRange(
          moment.outputStartSec,
          moment.outputEndSec,
          outputSpan.startSec,
          outputSpan.endSec,
        )
      ) {
        issues.push({
          severity: "error",
          code: "CONS-TL-03",
          message: `Moment ${moment.momentId} outside output span`,
          outputId: output.outputId,
        });
      }
    }
  }
}

function validateMediaTimeRanges(recipe, issues) {
  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.videoOutSec <= segment.videoInSec) {
        issues.push({
          severity: "error",
          code: "CONS-TL-04",
          message: `Segment ${segment.segmentId}: videoOutSec <= videoInSec`,
          outputId: output.outputId,
          segmentId: segment.segmentId,
        });
      }

      if (
        segment.audioOutSec <= segment.audioInSec
        && segment.audioPolicy !== "from_prev"
        && segment.audioPolicy !== "from_next"
        && segment.audioPolicy !== "mute"
      ) {
        issues.push({
          severity: "error",
          code: "CONS-TL-04",
          message: `Segment ${segment.segmentId}: audioOutSec <= audioInSec`,
          outputId: output.outputId,
          segmentId: segment.segmentId,
        });
      }
    }
  }
}

function validateTextOverlays(recipe, issues, stylePresets, options) {
  for (const output of recipe.outputs ?? []) {
    const enriched = buildOutputTimeline(output, { wordIndexes: options.wordIndexes });
    const overlays = collectSegmentOverlays(enriched, output.outputId, stylePresets);

    for (const entry of overlays) {
      const text = entry.overlay.text ?? "";
      if (!String(text).trim()) {
        issues.push({
          severity: "error",
          code: "CONS-TX-01",
          message: `Overlay ${entry.overlay.overlayId ?? "?"} has empty text`,
          outputId: output.outputId,
          segmentId: entry.segment.segmentId,
          overlayId: entry.overlay.overlayId,
        });
      }
    }

    for (let i = 0; i < overlays.length; i += 1) {
      for (let j = i + 1; j < overlays.length; j += 1) {
        const left = overlays[i];
        const right = overlays[j];
        const leftText = normalizeOverlayText(left.overlay.text);
        const rightText = normalizeOverlayText(right.overlay.text);
        if (!leftText || leftText !== rightText) {
          continue;
        }
        const coverage = overlapCoverageRatio(
          left.startSec,
          left.endSec,
          right.startSec,
          right.endSec,
        );
        if (coverage >= 0.8) {
          issues.push({
            severity: "error",
            code: "CONS-TX-02",
            message: `Duplicate overlay text "${leftText}" with ${(coverage * 100).toFixed(0)}% overlap`,
            outputId: output.outputId,
            overlayId: right.overlay.overlayId ?? left.overlay.overlayId,
          });
        }
      }
    }

    const payoffOverlays = overlays.filter((entry) => resolveOverlayRole(entry.overlay) === "payoff");
    const ctaOverlays = overlays.filter(
      (entry) => resolveOverlayRole(entry.overlay) === "cta" || entry.overlay.style === "cta",
    );
    for (const cta of ctaOverlays) {
      for (const payoff of payoffOverlays) {
        if (
          timeRangesOverlap(cta.startSec, cta.endSec, payoff.startSec, payoff.endSec)
        ) {
          issues.push({
            severity: "warning",
            code: "CONS-TX-03",
            message: `CTA overlay overlaps payoff overlay`,
            outputId: output.outputId,
            overlayId: cta.overlay.overlayId,
          });
          break;
        }
      }
    }
  }
}

function validateLayoutBands(recipe, issues, stylePresets, options) {
  for (const output of recipe.outputs ?? []) {
    const enriched = buildOutputTimeline(output, { wordIndexes: options.wordIndexes });
    const overlays = collectSegmentOverlays(enriched, output.outputId, stylePresets);

    const activeSubtitleSegments = enriched
      .filter((segment) => resolveSubtitleBand(segment) != null)
      .map((segment) => ({
        segment,
        band: resolveSubtitleBand(segment),
        ...resolveSubtitleWindow(segment),
      }));

    for (let i = 0; i < activeSubtitleSegments.length; i += 1) {
      for (let j = i + 1; j < activeSubtitleSegments.length; j += 1) {
        const left = activeSubtitleSegments[i];
        const right = activeSubtitleSegments[j];
        if (left.band !== right.band) {
          continue;
        }
        if (timeRangesOverlap(left.startSec, left.endSec, right.startSec, right.endSec)) {
          issues.push({
            severity: "error",
            code: "CONS-LAY-01",
            message: `Segments ${left.segment.segmentId} and ${right.segment.segmentId} share subtitle band "${left.band}" with overlapping windows`,
            outputId: output.outputId,
            segmentId: right.segment.segmentId,
          });
        }
      }
    }

    for (const overlayEntry of overlays) {
      for (const subtitleEntry of activeSubtitleSegments) {
        if (overlayEntry.band !== subtitleEntry.band) {
          continue;
        }
        if (
          timeRangesOverlap(
            overlayEntry.startSec,
            overlayEntry.endSec,
            subtitleEntry.startSec,
            subtitleEntry.endSec,
          )
        ) {
          issues.push({
            severity: "error",
            code: "CONS-LAY-02",
            message: `Overlay ${overlayEntry.overlay.overlayId ?? "?"} collides with subtitles on ${subtitleEntry.segment.segmentId}`,
            outputId: output.outputId,
            segmentId: subtitleEntry.segment.segmentId,
            overlayId: overlayEntry.overlay.overlayId,
          });
        }
      }
    }

    for (let i = 0; i < overlays.length; i += 1) {
      for (let j = i + 1; j < overlays.length; j += 1) {
        const left = overlays[i];
        const right = overlays[j];
        if (left.band !== right.band) {
          continue;
        }
        if (timeRangesOverlap(left.startSec, left.endSec, right.startSec, right.endSec)) {
          issues.push({
            severity: "warning",
            code: "CONS-LAY-03",
            message: `Overlays ${left.overlay.overlayId ?? "?"} and ${right.overlay.overlayId ?? "?"} share band "${left.band}"`,
            outputId: output.outputId,
            overlayId: right.overlay.overlayId ?? left.overlay.overlayId,
          });
        }
      }
    }
  }
}

/**
 * @param {object} recipe
 * @param {{ stylePresets?: object, wordIndexes?: object[]|object }} [options]
 * @returns {Array<{ severity: string, code: string, message: string, outputId?: string, segmentId?: string, overlayId?: string }>}
 */
export function validateRecipeConsistency(recipe, options = {}) {
  const issues = [];
  const stylePresets = resolveStylePresets(recipe, options);

  validateTimelineRanges(recipe, issues, options);
  validateSegmentContinuity(recipe, issues, options);
  validateOwnershipWindows(recipe, issues, stylePresets, options);
  validateMediaTimeRanges(recipe, issues);
  validateTextOverlays(recipe, issues, stylePresets, options);
  validateLayoutBands(recipe, issues, stylePresets, options);

  return issues;
}

/**
 * @param {object} recipe
 * @param {{ stylePresets?: object, wordIndexes?: object[]|object }} [options]
 * @returns {{ issues: object[], fixes: object[], approved: boolean }}
 */
export function runConsistencyAuditor(recipe, options = {}) {
  const fixes = sanitizeRecipeConsistency(recipe, options);
  const issues = validateRecipeConsistency(recipe, options);
  const approved = !issues.some((issue) => issue.severity === "error");
  return { issues, fixes, approved };
}

export { MIN_OVERLAY_DURATION_SEC, TIMELINE_TOLERANCE_SEC };
