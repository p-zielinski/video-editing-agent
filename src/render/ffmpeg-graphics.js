import { runFfmpeg } from "../lib/ffmpeg.js";
import { sanitizeTextForSafety } from "../lib/profanity-censor.js";

function resolveSafeZone(dimensions, stylePresets, format) {
  if (format && stylePresets?.formats?.[format]?.safeZone) {
    return stylePresets.formats[format].safeZone;
  }
  for (const entry of Object.values(stylePresets?.formats ?? {})) {
    if (entry.width === dimensions.width && entry.height === dimensions.height && entry.safeZone) {
      return entry.safeZone;
    }
  }
  return null;
}

function overlayPosition(position, dimensions) {
  const w = dimensions.width;
  const h = dimensions.height;
  switch (position) {
    case "top_center":
      return { x: `(w-text_w)/2`, y: `${Math.round(h * 0.12)}` };
    case "bottom_center":
      return { x: `(w-text_w)/2`, y: `h-text_h-${Math.round(h * 0.1)}` };
    case "center":
    default:
      return { x: `(w-text_w)/2`, y: `(h-text_h)/2` };
  }
}

function clampOverlayPosition(pos, safeZone) {
  if (!safeZone) {
    return pos;
  }
  const { top, bottom, left, right } = safeZone;
  // FFmpeg drawtext splits options on ':' and ',' — nest max/min in quoted expressions.
  return {
    x: `'max(${left},min(w-text_w-${right},${pos.x}))'`,
    y: `'max(${top},min(h-text_h-${bottom},${pos.y}))'`,
  };
}

function escapeDrawtext(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function roundSec(n) {
  return Math.round(n * 1000) / 1000;
}

function isSlideAnimation(animation) {
  return animation === "slide_up"
    || animation === "slide_down"
    || animation === "slide_left"
    || animation === "slide_right";
}

/**
 * Animate x/y drawtext expression for slide-in during entry fade window.
 */
export function buildSlidePositionExpression(restExpr, animation, startSec, endSec, fadeSec, dimensions) {
  const duration = endSec - startSec;
  const fade = Math.min(fadeSec, duration / 2);
  if (!isSlideAnimation(animation) || fade <= 0) {
    return restExpr;
  }

  const s = roundSec(startSec);
  const f = roundSec(fade);
  const h = dimensions.height;
  const w = dimensions.width;

  switch (animation) {
    case "slide_up":
      return `'if(lt(t\\,${s})\\,${h}\\,if(lt(t\\,${s + f})\\,${h}-(${h}-(${restExpr}))*((t-${s})/${f})\\,${restExpr}))'`;
    case "slide_down":
      return `'if(lt(t\\,${s})\\,-text_h\\,if(lt(t\\,${s + f})\\,-text_h+(${restExpr}+text_h)*((t-${s})/${f})\\,${restExpr}))'`;
    case "slide_left":
      return `'if(lt(t\\,${s})\\,${w}\\,if(lt(t\\,${s + f})\\,${w}-(${w}-(${restExpr}))*((t-${s})/${f})\\,${restExpr}))'`;
    case "slide_right":
      return `'if(lt(t\\,${s})\\,-text_w\\,if(lt(t\\,${s + f})\\,-text_w+(${restExpr}+text_w)*((t-${s})/${f})\\,${restExpr}))'`;
    default:
      return restExpr;
  }
}

const OVERLAY_FADE_SEC = 0.3;

/**
 * Resolve overlay animation: per-overlay override, then style preset, then fade.
 */
export function resolveOverlayAnimation(overlay, style) {
  return overlay.animation ?? style?.animation ?? "fade";
}

/**
 * FFmpeg drawtext alpha expression (0–255): fade in first fadeSec, fade out last fadeSec.
 */
export function buildOverlayAlphaExpression(startSec, endSec, fadeSec = OVERLAY_FADE_SEC) {
  const duration = endSec - startSec;
  const fade = Math.min(fadeSec, duration / 2);
  if (fade <= 0) {
    return null;
  }
  const round = (n) => Math.round(n * 1000) / 1000;
  const s = round(startSec);
  const e = round(endSec);
  const f = round(fade);
  return `if(lt(t,${s}),0,if(lt(t,${s + f}),255*(t-${s})/${f},if(lt(t,${e - f}),255,if(lt(t,${e}),255*(${e}-t)/${f},0))))`;
}

function parseBackgroundColor(styleColor) {
  if (!styleColor) {
    return "black@0.55";
  }
  const rgba = styleColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i);
  if (rgba) {
    const alpha = rgba[4] ?? "1";
    const hex = [rgba[1], rgba[2], rgba[3]]
      .map((v) => Number(v).toString(16).padStart(2, "0"))
      .join("");
    return `0x${hex}@${alpha}`;
  }
  if (styleColor.startsWith("#")) {
    return `${styleColor.replace("#", "0x")}@0.55`;
  }
  return "black@0.55";
}

function overlayBoxPosition(position, dimensions, boxW, boxH) {
  const h = dimensions.height ?? 1080;
  const marginY = Math.round(h * 0.1);
  const x = `(w-${boxW})/2`;
  switch (position) {
    case "top_center":
      return { x, y: String(marginY) };
    case "bottom_center":
      return { x, y: `h-${boxH + marginY}` };
    case "center":
    default:
      return { x, y: `(h-${boxH})/2` };
  }
}

function buildDrawboxFilter(overlay, style, dimensions) {
  if (!style.backgroundColor) {
    return null;
  }
  const padding = style.paddingPx ?? 12;
  const fontSize = style.fontSizePx ?? 48;
  const boxH = fontSize + padding * 2;
  const enable = `between(t,${overlay.outputStartSec},${overlay.outputEndSec})`;
  const color = parseBackgroundColor(style.backgroundColor);
  const boxW = Math.round((dimensions.width ?? 1920) * 0.72);
  const position = overlay.position ?? style.position ?? "center";
  const { x, y } = overlayBoxPosition(position, dimensions, boxW, boxH);
  return `drawbox=x='${x}':y='${y}':w=${boxW}:h=${boxH}:color=${color}:t=fill:enable='${enable}'`;
}

/**
 * Build drawtext + optional drawbox filter strings for text overlays (exported for unit tests).
 */
export function buildDrawtextFilters(overlays, { dimensions, stylePresets, format }) {
  const safeZone = resolveSafeZone(dimensions, stylePresets, format);
  return overlays.flatMap((overlay) => {
    const style = stylePresets.overlays[overlay.style] ?? stylePresets.overlays.hook_large;
    const pos = clampOverlayPosition(
      overlayPosition(overlay.position ?? style.position, dimensions),
      safeZone,
    );
    const fontSize = style.fontSizePx ?? 48;
    const fontColor = (style.color ?? "#FFFFFF").replace("#", "0x");
    let displayText = sanitizeTextForSafety(overlay.text ?? "");
    if (style.textTransform === "uppercase") {
      displayText = displayText.toUpperCase();
    }
    const text = escapeDrawtext(displayText);
    const enable = `between(t,${overlay.outputStartSec},${overlay.outputEndSec})`;
    const animation = resolveOverlayAnimation(overlay, style);

    let xExpr = pos.x;
    let yExpr = pos.y;
    if (isSlideAnimation(animation)) {
      if (animation === "slide_left" || animation === "slide_right") {
        xExpr = buildSlidePositionExpression(
          pos.x,
          animation,
          overlay.outputStartSec,
          overlay.outputEndSec,
          OVERLAY_FADE_SEC,
          dimensions,
        );
      } else {
        yExpr = buildSlidePositionExpression(
          pos.y,
          animation,
          overlay.outputStartSec,
          overlay.outputEndSec,
          OVERLAY_FADE_SEC,
          dimensions,
        );
      }
    }

    const parts = [
      `drawtext=text='${text}'`,
      `fontsize=${fontSize}`,
      `fontcolor=${fontColor}`,
      `x=${xExpr}`,
      `y=${yExpr}`,
      `enable='${enable}'`,
    ];

    if (style.strokeWidthPx) {
      parts.push(`borderw=${style.strokeWidthPx}`);
    }
    if (style.strokeColor) {
      parts.push(`bordercolor=${style.strokeColor.replace("#", "0x")}`);
    }

    if (animation === "fade" || isSlideAnimation(animation)) {
      const alpha = buildOverlayAlphaExpression(overlay.outputStartSec, overlay.outputEndSec);
      if (alpha) {
        parts.push(`alpha='${alpha}'`);
      }
    }

    const drawtext = parts.join(":");
    const drawbox = buildDrawboxFilter(overlay, style, dimensions);
    return drawbox ? [drawbox, drawtext] : [drawtext];
  });
}

/**
 * Apply text overlays via drawtext filter.
 */
export async function applyTextOverlays(inputPath, outputPath, {
  overlays = [],
  encodeProfile,
  dimensions,
  stylePresets,
  format,
}) {
  if (!overlays.length) {
    const { copyFileSync } = await import("node:fs");
    copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  const filters = buildDrawtextFilters(overlays, { dimensions, stylePresets, format });

  await runFfmpeg(
    [
      "-y",
      "-i", inputPath,
      "-vf", filters.join(","),
      "-c:v", encodeProfile.videoCodec,
      "-preset", encodeProfile.preset,
      "-crf", String(encodeProfile.crf),
      "-c:a", "copy",
      outputPath,
    ],
    { label: "text overlays" },
  );

  return outputPath;
}
