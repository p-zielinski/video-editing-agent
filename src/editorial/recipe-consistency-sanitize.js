import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import { DEFAULT_RENDER_STYLE_PRESETS } from "../render/style-presets.js";

const MIN_OVERLAY_DURATION_SEC = 0.3;

function normalizeLayoutBand(positionOrPlacement) {
  if (positionOrPlacement == null || positionOrPlacement === "") {
    return null;
  }
  const value = String(positionOrPlacement).toLowerCase();
  if (value === "bottom" || value === "bottom_center" || value === "bottom_third") {
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

function resolveSubtitleBand(segment) {
  const policy = segment?.subtitles?.policy ?? "off";
  if (policy === "off") {
    return null;
  }
  return normalizeLayoutBand(segment.subtitles?.placement) ?? "bottom";
}

function resolveOverlayBand(overlay, stylePresets = DEFAULT_RENDER_STYLE_PRESETS) {
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
  if (style.startsWith("hook_")) {
    return "hook";
  }
  if (style === "chapter_card") {
    return "chapter";
  }
  if (style === "closure_bracket") {
    return "closure";
  }
  if (style === "emphasis") {
    return "retention_beat";
  }
  return undefined;
}

function overlayKeepScore(overlay) {
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

function timeRangesOverlap(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function overlapCoverageRatio(a0, a1, b0, b1) {
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

function oppositeBand(band) {
  if (band === "bottom") {
    return "top";
  }
  if (band === "top") {
    return "bottom";
  }
  return "top";
}

function bandToPosition(band) {
  if (band === "top") {
    return "top_center";
  }
  if (band === "bottom") {
    return "bottom_center";
  }
  return "center";
}

function resolveSubtitleWindow(segment) {
  const segStart = segment.outputStartSec ?? 0;
  const segEnd = segment.outputEndSec ?? segStart;
  const startSec = segment.subtitles?.outputStartSec ?? segStart;
  const endSec = segment.subtitles?.outputEndSec ?? segEnd;
  return { startSec, endSec };
}

function overlayAbsoluteTimes(overlay, segment) {
  const startSec = overlay.outputStartSec ?? segment.outputStartSec ?? 0;
  const endSec = overlay.outputEndSec ?? startSec;
  return { startSec, endSec };
}

function isEnrichOrCtaOverlay(overlay) {
  const overlayId = overlay.overlayId ?? "";
  return overlayId.startsWith("enrich_") || resolveOverlayRole(overlay) === "cta";
}

function dropOverlay(segment, overlayRef, fixes, fix) {
  segment.textOverlays = (segment.textOverlays ?? []).filter(
    (overlay) => overlay !== overlayRef,
  );
  fixes.push(fix);
}

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {object} recipe
 * @param {{ stylePresets?: object, wordIndexes?: object[]|object }} [options]
 * @returns {Array<{ code: string, action: string, message: string, outputId?: string, segmentId?: string, overlayId?: string }>}
 */
export function sanitizeRecipeConsistency(recipe, options = {}) {
  const fixes = [];
  const stylePresets = resolveStylePresets(recipe, options);

  for (const output of recipe.outputs ?? []) {
    const enriched = buildOutputTimeline(output, { wordIndexes: options.wordIndexes });

    for (const segment of enriched) {
      const segStart = segment.outputStartSec ?? 0;
      const segEnd = segment.outputEndSec ?? segStart;
      const rawSegment = output.timeline.find((entry) => entry.segmentId === segment.segmentId);
      if (!rawSegment) {
        continue;
      }

      const keptOverlays = [];
      for (const overlay of rawSegment.textOverlays ?? []) {
        if (!String(overlay.text ?? "").trim()) {
          fixes.push({
            code: "CONS-TX-01",
            action: "drop_empty_overlay",
            message: `Dropped empty overlay ${overlay.overlayId ?? "?"}`,
            outputId: output.outputId,
            segmentId: rawSegment.segmentId,
            overlayId: overlay.overlayId,
          });
          continue;
        }
        keptOverlays.push(overlay);
      }
      rawSegment.textOverlays = keptOverlays;
    }

    for (const segment of enriched) {
      const rawSegment = output.timeline.find((entry) => entry.segmentId === segment.segmentId);
      if (!rawSegment) {
        continue;
      }
      const segStart = segment.outputStartSec ?? 0;
      const segEnd = segment.outputEndSec ?? segStart;

      const nextOverlays = [];
      for (const overlay of rawSegment.textOverlays ?? []) {
        let startSec = overlay.outputStartSec ?? segStart;
        let endSec = overlay.outputEndSec ?? startSec;
        const clampedStart = clampValue(startSec, segStart, segEnd);
        const clampedEnd = clampValue(endSec, segStart, segEnd);

        if (clampedStart !== startSec || clampedEnd !== endSec) {
          if (clampedEnd <= clampedStart) {
            fixes.push({
              code: "CONS-TL-03",
              action: "drop_overlay_out_of_range",
              message: `Dropped overlay ${overlay.overlayId ?? "?"} after clamping outside segment`,
              outputId: output.outputId,
              segmentId: rawSegment.segmentId,
              overlayId: overlay.overlayId,
            });
            continue;
          }
          overlay.outputStartSec = clampedStart;
          overlay.outputEndSec = clampedEnd;
          fixes.push({
            code: "CONS-TL-03",
            action: "clamp_overlay_window",
            message: `Clamped overlay ${overlay.overlayId ?? "?"} to segment bounds`,
            outputId: output.outputId,
            segmentId: rawSegment.segmentId,
            overlayId: overlay.overlayId,
          });
        }
        nextOverlays.push(overlay);
      }
      rawSegment.textOverlays = nextOverlays;

      if (rawSegment.subtitles?.policy && rawSegment.subtitles.policy !== "off") {
        const { startSec, endSec } = resolveSubtitleWindow(segment);
        const clampedStart = clampValue(startSec, segStart, segEnd);
        const clampedEnd = clampValue(endSec, segStart, segEnd);
        if (clampedStart !== startSec || clampedEnd !== endSec) {
          rawSegment.subtitles.outputStartSec = clampedStart;
          rawSegment.subtitles.outputEndSec = clampedEnd;
          fixes.push({
            code: "CONS-TL-03",
            action: "clamp_subtitle_window",
            message: `Clamped subtitles on ${rawSegment.segmentId} to segment bounds`,
            outputId: output.outputId,
            segmentId: rawSegment.segmentId,
          });
        }
      }
    }

    const duplicateCandidates = [];
    for (const segment of enriched) {
      const rawSegment = output.timeline.find((entry) => entry.segmentId === segment.segmentId);
      for (const overlay of rawSegment?.textOverlays ?? []) {
        const { startSec, endSec } = overlayAbsoluteTimes(overlay, segment);
        duplicateCandidates.push({
          overlay,
          segment: rawSegment,
          text: normalizeOverlayText(overlay.text),
          startSec,
          endSec,
          score: overlayKeepScore(overlay),
        });
      }
    }

    const droppedOverlayIds = new Set();
    for (let i = 0; i < duplicateCandidates.length; i += 1) {
      for (let j = i + 1; j < duplicateCandidates.length; j += 1) {
        const left = duplicateCandidates[i];
        const right = duplicateCandidates[j];
        if (!left.text || left.text !== right.text) {
          continue;
        }
        if (overlapCoverageRatio(left.startSec, left.endSec, right.startSec, right.endSec) < 0.8) {
          continue;
        }

        const drop = left.score >= right.score ? right : left;
        const keep = left.score >= right.score ? left : right;
        const dropKey = drop.overlay.overlayId ?? `idx:${i}:${j}:drop`;
        if (droppedOverlayIds.has(dropKey) || droppedOverlayIds.has(drop.overlay)) {
          continue;
        }
        droppedOverlayIds.add(dropKey);
        droppedOverlayIds.add(drop.overlay);
        dropOverlay(drop.segment, drop.overlay, fixes, {
          code: "CONS-TX-02",
          action: "drop_duplicate_overlay",
          message: `Dropped duplicate overlay ${drop.overlay.overlayId ?? "?"} (kept ${keep.overlay.overlayId ?? "?"})`,
          outputId: output.outputId,
          segmentId: drop.segment.segmentId,
          overlayId: drop.overlay.overlayId,
        });
      }
    }

    const refreshedEnriched = buildOutputTimeline(output, { wordIndexes: options.wordIndexes });
    const payoffRanges = [];
    for (const segment of refreshedEnriched) {
      const rawSegment = output.timeline.find((entry) => entry.segmentId === segment.segmentId);
      for (const overlay of rawSegment?.textOverlays ?? []) {
        if (resolveOverlayRole(overlay) !== "payoff") {
          continue;
        }
        const { startSec, endSec } = overlayAbsoluteTimes(overlay, segment);
        payoffRanges.push({ startSec, endSec });
      }
    }

    for (const segment of refreshedEnriched) {
      const rawSegment = output.timeline.find((entry) => entry.segmentId === segment.segmentId);
      if (!rawSegment) {
        continue;
      }
      const kept = [];
      for (const overlay of rawSegment.textOverlays ?? []) {
        if (resolveOverlayRole(overlay) !== "cta" && overlay.style !== "cta") {
          kept.push(overlay);
          continue;
        }
        const { startSec, endSec } = overlayAbsoluteTimes(overlay, segment);
        const overlappingPayoff = payoffRanges.find(
          (range) => timeRangesOverlap(startSec, endSec, range.startSec, range.endSec),
        );
        if (!overlappingPayoff) {
          kept.push(overlay);
          continue;
        }

        const overlapStart = Math.max(startSec, overlappingPayoff.startSec);
        const overlapEnd = Math.min(endSec, overlappingPayoff.endSec);
        const overlapDur = overlapEnd - overlapStart;
        const ctaDur = endSec - startSec;
        const mostlyInside = ctaDur > 0 && overlapDur / ctaDur >= 0.5;

        if (mostlyInside || isEnrichOrCtaOverlay(overlay)) {
          fixes.push({
            code: "CONS-TX-03",
            action: "resolve_cta_payoff_overlap",
            message: `Dropped CTA overlay ${overlay.overlayId ?? "?"} overlapping payoff`,
            outputId: output.outputId,
            segmentId: rawSegment.segmentId,
            overlayId: overlay.overlayId,
          });
          continue;
        }

        const newEnd = overlappingPayoff.startSec;
        if (newEnd - startSec < MIN_OVERLAY_DURATION_SEC) {
          fixes.push({
            code: "CONS-TX-03",
            action: "resolve_cta_payoff_overlap",
            message: `Dropped CTA overlay ${overlay.overlayId ?? "?"} after shortening below minimum duration`,
            outputId: output.outputId,
            segmentId: rawSegment.segmentId,
            overlayId: overlay.overlayId,
          });
          continue;
        }

        overlay.outputEndSec = newEnd;
        fixes.push({
          code: "CONS-TX-03",
          action: "resolve_cta_payoff_overlap",
          message: `Shortened CTA overlay ${overlay.overlayId ?? "?"} before payoff`,
          outputId: output.outputId,
          segmentId: rawSegment.segmentId,
          overlayId: overlay.overlayId,
        });
        kept.push(overlay);
      }
      rawSegment.textOverlays = kept;
    }

    const layoutEnriched = buildOutputTimeline(output, { wordIndexes: options.wordIndexes });
    const activeSubtitleSegments = layoutEnriched
      .filter((segment) => resolveSubtitleBand(segment) != null)
      .map((segment) => ({
        segment,
        rawSegment: output.timeline.find((entry) => entry.segmentId === segment.segmentId),
        band: resolveSubtitleBand(segment),
        ...resolveSubtitleWindow(segment),
      }));

    // CONS-LAY-01: overlapping subtitle windows on the same band → move later segment placement
    for (let i = 0; i < activeSubtitleSegments.length; i += 1) {
      for (let j = i + 1; j < activeSubtitleSegments.length; j += 1) {
        const left = activeSubtitleSegments[i];
        const right = activeSubtitleSegments[j];
        if (left.band !== right.band) {
          continue;
        }
        if (!timeRangesOverlap(left.startSec, left.endSec, right.startSec, right.endSec)) {
          continue;
        }
        if (!right.rawSegment?.subtitles) {
          continue;
        }
        const newPlacement = oppositeBand(right.band);
        right.rawSegment.subtitles.placement = newPlacement;
        right.band = newPlacement;
        fixes.push({
          code: "CONS-LAY-01",
          action: "move_subtitle_placement",
          message: `Moved subtitles on ${right.rawSegment.segmentId} to ${newPlacement} to avoid overlap with ${left.segment.segmentId}`,
          outputId: output.outputId,
          segmentId: right.rawSegment.segmentId,
        });
      }
    }

    // CONS-LAY-02: overlays anywhere on the output vs each active subtitle window
    const layoutOverlayEntries = [];
    for (const segment of layoutEnriched) {
      const rawSegment = output.timeline.find((entry) => entry.segmentId === segment.segmentId);
      for (const overlay of rawSegment?.textOverlays ?? []) {
        const { startSec, endSec } = overlayAbsoluteTimes(overlay, segment);
        layoutOverlayEntries.push({
          overlay,
          rawSegment,
          segment,
          band: resolveOverlayBand(overlay, stylePresets),
          startSec,
          endSec,
        });
      }
    }

    for (const subtitleEntry of activeSubtitleSegments) {
      for (const overlayEntry of layoutOverlayEntries) {
        if (!overlayEntry.rawSegment) {
          continue;
        }
        if (overlayEntry.band !== subtitleEntry.band) {
          continue;
        }
        if (
          !timeRangesOverlap(
            overlayEntry.startSec,
            overlayEntry.endSec,
            subtitleEntry.startSec,
            subtitleEntry.endSec,
          )
        ) {
          continue;
        }

        const overlay = overlayEntry.overlay;
        const rawSegment = overlayEntry.rawSegment;
        const band = overlayEntry.band;
        const startSec = overlayEntry.startSec;

        const targetBand = oppositeBand(band);
        const movedPosition = bandToPosition(targetBand);
        const movedBand = normalizeLayoutBand(movedPosition);
        if (movedBand !== subtitleEntry.band) {
          overlay.position = movedPosition;
          overlayEntry.band = movedBand;
          fixes.push({
            code: "CONS-LAY-02",
            action: "move_overlay_band",
            message: `Moved overlay ${overlay.overlayId ?? "?"} to ${movedPosition}`,
            outputId: output.outputId,
            segmentId: rawSegment.segmentId,
            overlayId: overlay.overlayId,
          });
          continue;
        }

        if (overlayKeepScore(overlay) >= 400 && subtitleEntry.rawSegment?.subtitles) {
          subtitleEntry.rawSegment.subtitles.placement = oppositeBand(subtitleEntry.band);
          subtitleEntry.band = subtitleEntry.rawSegment.subtitles.placement;
          fixes.push({
            code: "CONS-LAY-02",
            action: "move_subtitle_placement",
            message: `Moved subtitles on ${subtitleEntry.rawSegment.segmentId} to ${subtitleEntry.band}`,
            outputId: output.outputId,
            segmentId: subtitleEntry.rawSegment.segmentId,
            overlayId: overlay.overlayId,
          });
          continue;
        }

        if (isEnrichOrCtaOverlay(overlay)) {
          dropOverlay(rawSegment, overlay, fixes, {
            code: "CONS-LAY-02",
            action: "drop_overlay_layout_conflict",
            message: `Dropped layout-conflicting overlay ${overlay.overlayId ?? "?"}`,
            outputId: output.outputId,
            segmentId: rawSegment.segmentId,
            overlayId: overlay.overlayId,
          });
          continue;
        }

        const newEnd = subtitleEntry.startSec;
        if (newEnd - startSec < MIN_OVERLAY_DURATION_SEC) {
          dropOverlay(rawSegment, overlay, fixes, {
            code: "CONS-LAY-02",
            action: "drop_overlay_layout_conflict",
            message: `Dropped overlay ${overlay.overlayId ?? "?"} after layout shorten`,
            outputId: output.outputId,
            segmentId: rawSegment.segmentId,
            overlayId: overlay.overlayId,
          });
          continue;
        }

        overlay.outputEndSec = newEnd;
        overlayEntry.endSec = newEnd;
        fixes.push({
          code: "CONS-LAY-02",
          action: "shorten_overlay",
          message: `Shortened overlay ${overlay.overlayId ?? "?"} before subtitle window`,
          outputId: output.outputId,
          segmentId: rawSegment.segmentId,
          overlayId: overlay.overlayId,
        });
      }
    }

    const overlayLayoutEnriched = buildOutputTimeline(output, { wordIndexes: options.wordIndexes });
    const overlayEntries = [];
    for (const segment of overlayLayoutEnriched) {
      const rawSegment = output.timeline.find((entry) => entry.segmentId === segment.segmentId);
      for (const overlay of rawSegment?.textOverlays ?? []) {
        const { startSec, endSec } = overlayAbsoluteTimes(overlay, segment);
        overlayEntries.push({
          overlay,
          rawSegment,
          band: resolveOverlayBand(overlay, stylePresets),
          startSec,
          endSec,
          score: overlayKeepScore(overlay),
        });
      }
    }

    for (let i = 0; i < overlayEntries.length; i += 1) {
      for (let j = i + 1; j < overlayEntries.length; j += 1) {
        const left = overlayEntries[i];
        const right = overlayEntries[j];
        if (left.band !== right.band) {
          continue;
        }
        if (!timeRangesOverlap(left.startSec, left.endSec, right.startSec, right.endSec)) {
          continue;
        }

        const lower = left.score >= right.score ? right : left;
        const higher = left.score >= right.score ? left : right;
        const targetBand = oppositeBand(lower.band);
        const movedPosition = bandToPosition(targetBand);

        const bandTaken = overlayEntries.some((entry) => {
          if (entry.overlay.overlayId === lower.overlay.overlayId) {
            return false;
          }
          if (resolveOverlayBand(entry.overlay, stylePresets) !== targetBand) {
            return false;
          }
          return timeRangesOverlap(
            entry.startSec,
            entry.endSec,
            lower.startSec,
            lower.endSec,
          );
        });

        if (!bandTaken) {
          lower.overlay.position = movedPosition;
          lower.band = targetBand;
          fixes.push({
            code: "CONS-LAY-03",
            action: "move_overlay_band",
            message: `Moved lower-priority overlay ${lower.overlay.overlayId ?? "?"} to ${movedPosition}`,
            outputId: output.outputId,
            segmentId: lower.rawSegment.segmentId,
            overlayId: lower.overlay.overlayId,
          });
          continue;
        }

        if (isEnrichOrCtaOverlay(lower.overlay)) {
          dropOverlay(lower.rawSegment, lower.overlay, fixes, {
            code: "CONS-LAY-03",
            action: "drop_overlay_layout_conflict",
            message: `Dropped lower-priority overlay ${lower.overlay.overlayId ?? "?"}`,
            outputId: output.outputId,
            segmentId: lower.rawSegment.segmentId,
            overlayId: lower.overlay.overlayId,
          });
          continue;
        }

        const shortenEnd = higher.startSec;
        if (shortenEnd - lower.startSec < MIN_OVERLAY_DURATION_SEC) {
          dropOverlay(lower.rawSegment, lower.overlay, fixes, {
            code: "CONS-LAY-03",
            action: "drop_overlay_layout_conflict",
            message: `Dropped overlay ${lower.overlay.overlayId ?? "?"} after layout shorten`,
            outputId: output.outputId,
            segmentId: lower.rawSegment.segmentId,
            overlayId: lower.overlay.overlayId,
          });
          continue;
        }

        lower.overlay.outputEndSec = shortenEnd;
        lower.endSec = shortenEnd;
        fixes.push({
          code: "CONS-LAY-03",
          action: "shorten_overlay",
          message: `Shortened overlay ${lower.overlay.overlayId ?? "?"} to avoid band collision`,
          outputId: output.outputId,
          segmentId: lower.rawSegment.segmentId,
          overlayId: lower.overlay.overlayId,
        });
      }
    }

    for (const segment of output.timeline ?? []) {
      const kept = [];
      for (const overlay of segment.textOverlays ?? []) {
        const startSec = overlay.outputStartSec ?? 0;
        const endSec = overlay.outputEndSec ?? startSec;
        if (endSec <= startSec) {
          fixes.push({
            code: "CONS-TL-01",
            action: "drop_overlay_out_of_range",
            message: `Dropped overlay ${overlay.overlayId ?? "?"} with invalid time range`,
            outputId: output.outputId,
            segmentId: segment.segmentId,
            overlayId: overlay.overlayId,
          });
          continue;
        }
        kept.push(overlay);
      }
      segment.textOverlays = kept;
    }
  }

  return fixes;
}
