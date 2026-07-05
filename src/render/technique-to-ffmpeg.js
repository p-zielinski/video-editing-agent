/**
 * Map techniqueId from creativeMoments to FFmpeg filter fragments.
 */

import { findAnchorNearTimestamp } from "../editorial/spatial-ref.js";

function bboxAnchorPx(spatialRef, dimensions) {
  if (!spatialRef?.bbox) {
    return null;
  }
  const [bx, by, bw, bh] = spatialRef.bbox;
  return {
    x: Math.round((bx + bw / 2) * (dimensions.width ?? 1080)),
    y: Math.round((by + bh / 2) * (dimensions.height ?? 1920)),
  };
}

function buildFollowSubjectZoompan({
  spatialRef,
  spatialIndex,
  outputStartSec,
  outputEndSec,
  dimensions,
  enable,
}) {
  const sceneId = spatialRef?.sceneId;
  const entry = spatialIndex?.scenes?.find((scene) => scene.sceneId === sceneId);
  const faceAnchors = (entry?.anchors ?? [])
    .filter((anchor) => anchor.type === "face" && anchor.timestampSec != null && anchor.bbox)
    .sort((a, b) => a.timestampSec - b.timestampSec);

  const width = dimensions.width ?? 1080;
  const staticX = spatialRef?.bbox
    ? Math.round(spatialRef.bbox[0] * width)
    : Math.round(width / 2);

  let xExpr = `if(${enable},${staticX}-(iw/zoom/2),iw/2-(iw/zoom/2))`;

  if (faceAnchors.length >= 2) {
    const pieces = faceAnchors.map((anchor) => {
      const px = Math.round((anchor.bbox[0] + anchor.bbox[2] / 2) * width);
      return { t: anchor.timestampSec, px };
    });
    const clauses = pieces.map((point, idx) => {
      const next = pieces[idx + 1];
      if (!next) {
        return `${point.px}`;
      }
      const span = Math.max(0.01, next.t - point.t);
      return `if(lt(t\\,${next.t})\\,${point.px}+(${next.px}-${point.px})*((t-${point.t})/${span.toFixed(3)})\\,${next.px})`;
    });
    xExpr = `if(${enable},${clauses[0]},iw/2-(iw/zoom/2))`;
  }

  const z = `zoompan=z='if(${enable},1.1,1)':d=1:x='${xExpr}':y='ih/2-(ih/zoom/2)':s=${dimensions.width}x${dimensions.height}`;
  return z;
}

function zoompanCenterCoords(spatialRef, dimensions) {
  const anchor = bboxAnchorPx(spatialRef, dimensions);
  if (anchor) {
    return { x: `${anchor.x}-(iw/zoom/2)`, y: `${anchor.y}-(ih/zoom/2)` };
  }
  return { x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
}

function buildScalePunchFilter({ outputStartSec, outputEndSec, factor, spatialRef, dimensions, inputLabel, outputLabel }) {
  const s = outputStartSec;
  const e = outputEndSec;
  const anchor = bboxAnchorPx(spatialRef, dimensions);

  if (anchor) {
    const z = `zoompan=z='if(between(t\\,${s}\\,${e})\\,${factor}\\,1)':d=1:x='${anchor.x}-(iw/zoom/2)':y='${anchor.y}-(ih/zoom/2)':s=${dimensions.width}x${dimensions.height}`;
    return `${inputLabel}${z}${outputLabel}`;
  }

  const scale = `scale=w='if(between(t\\,${s}\\,${e})\\,iw*${factor}\\,iw)':h='if(between(t\\,${s}\\,${e})\\,ih*${factor}\\,ih)':eval=frame`;
  return `${inputLabel}${scale}${outputLabel}`;
}

function buildWhipPanFilter({ outputStartSec, params, inputLabel, outputLabel }) {
  const direction = params.direction ?? "right";
  const durationSec = Math.min(0.5, Math.max(0.15, params.durationSec ?? 0.2));
  const s = outputStartSec;
  const e = s + durationSec;
  const sigmaStrong = 18;
  const sigmaWeak = 2;
  const isVertical = direction === "up" || direction === "down";
  const sigmaX = isVertical ? sigmaWeak : sigmaStrong;
  const sigmaY = isVertical ? sigmaStrong : sigmaWeak;
  const blur = `gblur=sigmaX='if(between(t\\,${s}\\,${e})\\,${sigmaX}\\,0)':sigmaY='if(between(t\\,${s}\\,${e})\\,${sigmaY}\\,0)':eval=frame`;
  return `${inputLabel}${blur}${outputLabel}`;
}

function buildMatchCutFilter({ outputStartSec, params, inputLabel, outputLabel }) {
  const durationSec = Math.min(0.25, Math.max(0.15, params.durationSec ?? 0.2));
  const s = outputStartSec;
  const e = s + durationSec;
  const matchType = params.matchType ?? "motion";
  const scaleFactor = matchType === "motion" ? 1.03 : 1.02;
  const sigmaStrong = matchType === "motion" ? 12 : 6;
  const sigmaWeak = 2;
  const direction = params.direction ?? "right";
  const isVertical = matchType === "motion" && (direction === "up" || direction === "down");
  const sigmaX = isVertical ? sigmaWeak : sigmaStrong;
  const sigmaY = isVertical ? sigmaStrong : sigmaWeak;
  const scale = `scale=w='if(between(t\\,${s}\\,${e})\\,iw*${scaleFactor}\\,iw)':h='if(between(t\\,${s}\\,${e})\\,ih*${scaleFactor}\\,ih)':eval=frame`;
  const blur = `gblur=sigmaX='if(between(t\\,${s}\\,${e})\\,${sigmaX}\\,0)':sigmaY='if(between(t\\,${s}\\,${e})\\,${sigmaY}\\,0)':eval=frame`;
  return `${inputLabel}${scale},${blur}${outputLabel}`;
}

function buildDipToBlackFilter({ outputStartSec, params, inputLabel, outputLabel }) {
  const rawDuration = params.durationSec ?? 0.6;
  const durationSec = Math.min(0.8, Math.max(0.3, rawDuration));
  const holdBlackSec = Math.min(params.holdBlackSec ?? 0.2, durationSec * 0.5);
  const fadeDur = Math.max(0.05, (durationSec - holdBlackSec) / 2);
  const fadeInStart = outputStartSec + fadeDur + holdBlackSec;
  const fadeOut = `fade=t=out:st=${outputStartSec}:d=${fadeDur}:color=black`;
  const fadeIn = `fade=t=in:st=${fadeInStart}:d=${fadeDur}:color=black`;
  return `${inputLabel}${fadeOut},${fadeIn}${outputLabel}`;
}

function buildCutMidSentencePulse({ outputStartSec, outputEndSec, params, inputLabel, outputLabel }) {
  const energy = params.energy ?? "medium";
  const pulseByEnergy = {
    low: { brightness: 0.18, contrast: 1.1 },
    medium: { brightness: 0.22, contrast: 1.12 },
    high: { brightness: 0.28, contrast: 1.15 },
  };
  const { brightness, contrast } = pulseByEnergy[energy] ?? pulseByEnergy.medium;
  const s = outputStartSec;
  const window = Math.max(0, outputEndSec - s);
  const pulseDur = window > 0 ? Math.min(0.18, Math.max(0.12, window)) : 0.15;
  const pulseEnd = s + pulseDur;
  const eq = `eq=brightness='if(between(t\\,${s}\\,${pulseEnd})\\,${brightness}\\,0)':contrast='if(between(t\\,${s}\\,${pulseEnd})\\,${contrast}\\,1)':eval=frame`;
  return `${inputLabel}${eq}${outputLabel}`;
}

function buildPatternInterruptFilter(moment, { dimensions, inputLabel, outputLabel }) {
  const { params = {}, outputStartSec, outputEndSec } = moment;
  const mode = params.mode ?? "cut_zoom";
  const s = outputStartSec;
  const e = outputEndSec;
  const duration = Math.max(0.1, e - s);
  const factor = params.factor ?? 1.1;

  if (mode === "cut_text") {
    return {
      filter: null,
      outputLabel: inputLabel,
      delegatesTo: "graphics",
      warning: "pattern_interrupt cut_text — tekst w pass overlay; stosowany subtelny scale+eq",
      fallbackFilter: `${inputLabel}scale=w='if(between(t\\,${s}\\,${e})\\,iw*1.05\\,iw)':h='if(between(t\\,${s}\\,${e})\\,ih*1.05\\,ih)':eval=frame,eq=brightness='if(between(t\\,${s}\\,${s + Math.min(0.12, duration / 3)})\\,0.08\\,0)':eval=frame${outputLabel}`,
    };
  }

  if (mode === "zoom_text") {
    const filter = buildScalePunchFilter({
      outputStartSec: s,
      outputEndSec: e,
      factor,
      spatialRef: moment.spatialRef,
      dimensions,
      inputLabel,
      outputLabel,
    });
    return { filter, outputLabel };
  }

  const scaleFilter = buildScalePunchFilter({
    outputStartSec: s,
    outputEndSec: e,
    factor,
    spatialRef: moment.spatialRef,
    dimensions,
    inputLabel,
    outputLabel: "[piz]",
  });
  const mid = s + duration / 2;
  const pulseDur = Math.min(0.15, duration / 3);
  const pulseStart = mid - pulseDur;
  const pulseEnd = mid + pulseDur;
  const eq = `[piz]eq=brightness='if(between(t\\,${pulseStart}\\,${pulseEnd})\\,0.25\\,0)':contrast=1:saturation=1:eval=frame${outputLabel}`;

  return { filter: `${scaleFilter};${eq}`, outputLabel };
}

export function buildTechniqueFilter(moment, { dimensions, spatialIndex, context, inputLabel = "[0:v]", outputLabel = "[vout]" }) {
  const { techniqueId, params = {}, spatialRef, outputStartSec, outputEndSec } = moment;
  const enable = `between(t,${outputStartSec},${outputEndSec})`;

  switch (techniqueId) {
    case "zoom_punch_in":
    case "snap_zoom": {
      const factor = params.factor ?? 1.1;
      const filter = buildScalePunchFilter({
        outputStartSec,
        outputEndSec,
        factor,
        spatialRef,
        dimensions,
        inputLabel,
        outputLabel,
      });
      return { filter, outputLabel };
    }
    case "zoom_punch_out": {
      const factor = params.factor ?? 0.92;
      const filter = buildScalePunchFilter({
        outputStartSec,
        outputEndSec,
        factor,
        spatialRef,
        dimensions,
        inputLabel,
        outputLabel,
      });
      return { filter, outputLabel };
    }
    case "zoom_slow_push": {
      const factor = params.factor ?? 1.05;
      const { x, y } = zoompanCenterCoords(spatialRef, dimensions);
      const z = `zoompan=z='if(${enable},min(zoom+0.001,${factor}),1)':d=125:x='${x}':y='${y}':s=${dimensions.width}x${dimensions.height}`;
      return { filter: `${inputLabel}${z}${outputLabel}`, outputLabel };
    }
    case "ken_burns_light": {
      const { x, y } = zoompanCenterCoords(spatialRef, dimensions);
      const z = `zoompan=z='if(${enable},min(zoom+0.0005,1.08),1)':d=125:x='${x}':y='${y}':s=${dimensions.width}x${dimensions.height}`;
      return { filter: `${inputLabel}${z}${outputLabel}`, outputLabel };
    }
    case "reframe_follow_subject": {
      if (!spatialRef?.bbox && !spatialRef?.sceneId) {
        return {
          filter: null,
          outputLabel: inputLabel,
          warning: "reframe_follow_subject — brak spatialRef; pominięto refraim",
        };
      }
      const tracked = spatialRef?.timestampSec != null
        ? findAnchorNearTimestamp(spatialIndex, spatialRef.sceneId, spatialRef.timestampSec, "face")
        : null;
      const effectiveRef = tracked
        ? { ...spatialRef, bbox: tracked.bbox, anchorType: tracked.type }
        : spatialRef;
      const z = buildFollowSubjectZoompan({
        spatialRef: effectiveRef,
        spatialIndex,
        outputStartSec,
        outputEndSec,
        dimensions,
        enable,
      });
      return { filter: `${inputLabel}${z}${outputLabel}`, outputLabel };
    }
    case "hard_cut_energy":
    case "jump_cut": {
      const s = outputStartSec;
      const window = Math.max(0, outputEndSec - s);
      const pulseDur = window > 0 ? Math.min(0.15, Math.max(0.1, window)) : 0.12;
      const pulseEnd = s + pulseDur;
      const eq = `eq=brightness='if(between(t\\,${s}\\,${pulseEnd})\\,0.15\\,0)':contrast='if(between(t\\,${s}\\,${pulseEnd})\\,1.08\\,1)':eval=frame`;
      return { filter: `${inputLabel}${eq}${outputLabel}`, outputLabel };
    }
    case "cut_mid_sentence": {
      const filter = buildCutMidSentencePulse({
        outputStartSec,
        outputEndSec,
        params,
        inputLabel,
        outputLabel,
      });
      return { filter, outputLabel };
    }
    case "dip_to_black": {
      const filter = buildDipToBlackFilter({
        outputStartSec,
        params,
        inputLabel,
        outputLabel,
      });
      return { filter, outputLabel };
    }
    case "whip_pan": {
      const filter = buildWhipPanFilter({
        outputStartSec,
        params,
        inputLabel,
        outputLabel,
      });
      return { filter, outputLabel };
    }
    case "match_cut": {
      const filter = buildMatchCutFilter({
        outputStartSec,
        params,
        inputLabel,
        outputLabel,
      });
      return { filter, outputLabel };
    }
    case "crossfade":
    case "wipe_left":
    case "wipe_right":
    case "wipe_up":
    case "wipe_down":
    case "slide_left":
    case "slide_right":
    case "slide_up":
    case "slide_down":
    case "cut_on_beat":
      return { filter: null, outputLabel: inputLabel, deferred: "concat" };
    case "pattern_interrupt": {
      const built = buildPatternInterruptFilter(moment, { dimensions, inputLabel, outputLabel });
      if (built.fallbackFilter && !built.filter) {
        return {
          filter: built.fallbackFilter,
          outputLabel,
          delegatesTo: built.delegatesTo,
          warning: built.warning,
        };
      }
      return { filter: built.filter, outputLabel: built.outputLabel ?? outputLabel, delegatesTo: built.delegatesTo };
    }
    case "hook_visual_punch": {
      const intensity = params.intensity ?? "strong";
      const factor = intensity === "subtle" ? 1.08 : intensity === "medium" ? 1.12 : 1.18;
      const s = outputStartSec;
      const e = outputEndSec;
      const scaleFilter = buildScalePunchFilter({
        outputStartSec: s,
        outputEndSec: e,
        factor,
        spatialRef,
        dimensions,
        inputLabel,
        outputLabel: "[hvp]",
      });
      const eq = `[hvp]eq=brightness='if(between(t\\,${s}\\,${e})\\,0.2\\,0)':contrast=1.05:eval=frame${outputLabel}`;
      return { filter: `${scaleFilter};${eq}`, outputLabel };
    }
    case "retention_beat": {
      const linkedId = params.linkedTechniqueId ?? "pattern_interrupt";
      if (linkedId === "pattern_interrupt") {
        const built = buildPatternInterruptFilter(
          { ...moment, techniqueId: "pattern_interrupt", params: { ...params, mode: params.mode ?? "cut_zoom" } },
          { dimensions, inputLabel, outputLabel },
        );
        if (built.fallbackFilter && !built.filter) {
          return {
            filter: built.fallbackFilter,
            outputLabel,
            delegatesTo: built.delegatesTo,
            warning: built.warning,
          };
        }
        return { filter: built.filter, outputLabel: built.outputLabel ?? outputLabel, delegatesTo: built.delegatesTo };
      }
      const s = outputStartSec;
      const e = outputEndSec;
      const factor = 1.06;
      const pulseDur = Math.min(0.12, (e - s) / 3);
      const pulseEnd = s + pulseDur;
      const scale = `scale=w='if(between(t\\,${s}\\,${e})\\,iw*${factor}\\,iw)':h='if(between(t\\,${s}\\,${e})\\,ih*${factor}\\,ih)':eval=frame`;
      const flash = `eq=brightness='if(between(t\\,${s}\\,${pulseEnd})\\,0.12\\,0)':eval=frame`;
      return { filter: `${inputLabel}${scale},${flash}${outputLabel}`, outputLabel };
    }
    case "hook_title_overlay":
    case "emphasis_text":
    case "chapter_card":
      return {
        filter: null,
        outputLabel: inputLabel,
        delegatesTo: "graphics",
        warning: `${techniqueId} — delegacja do pass overlay (textOverlays)`,
      };
    case "music_swell":
    case "music_drop":
    case "silence_beat":
    case "voice_pitch_shift":
      return { filter: null, outputLabel: inputLabel };
    default:
      return { filter: null, outputLabel: inputLabel };
  }
}

export function listSupportedTechniques() {
  return [
    "zoom_punch_in",
    "zoom_punch_out",
    "snap_zoom",
    "zoom_slow_push",
    "ken_burns_light",
    "reframe_follow_subject",
    "hook_visual_punch",
    "retention_beat",
    "pattern_interrupt",
    "dip_to_black",
    "whip_pan",
    "match_cut",
    "cut_mid_sentence",
  ];
}

export { buildPatternInterruptFilter, buildScalePunchFilter, bboxAnchorPx, buildDipToBlackFilter, buildCutMidSentencePulse, buildWhipPanFilter, buildMatchCutFilter };
