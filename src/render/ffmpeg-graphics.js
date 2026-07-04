import { runFfmpeg } from "../lib/ffmpeg.js";

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

/**
 * Build drawtext filter strings for text overlays (exported for unit tests).
 */
export function buildDrawtextFilters(overlays, { dimensions, stylePresets, format }) {
  const safeZone = resolveSafeZone(dimensions, stylePresets, format);
  return overlays.map((overlay) => {
    const style = stylePresets.overlays[overlay.style] ?? stylePresets.overlays.hook_large;
    const pos = clampOverlayPosition(
      overlayPosition(overlay.position ?? style.position, dimensions),
      safeZone,
    );
    const fontSize = style.fontSizePx ?? 48;
    const fontColor = (style.color ?? "#FFFFFF").replace("#", "0x");
    let displayText = overlay.text ?? "";
    if (style.textTransform === "uppercase") {
      displayText = displayText.toUpperCase();
    }
    const text = escapeDrawtext(displayText);
    const enable = `between(t,${overlay.outputStartSec},${overlay.outputEndSec})`;

    const parts = [
      `drawtext=text='${text}'`,
      `fontsize=${fontSize}`,
      `fontcolor=${fontColor}`,
      `x=${pos.x}`,
      `y=${pos.y}`,
      `enable='${enable}'`,
    ];

    if (style.strokeWidthPx) {
      parts.push(`borderw=${style.strokeWidthPx}`);
    }
    if (style.strokeColor) {
      parts.push(`bordercolor=${style.strokeColor.replace("#", "0x")}`);
    }

    if (resolveOverlayAnimation(overlay, style) === "fade") {
      const alpha = buildOverlayAlphaExpression(overlay.outputStartSec, overlay.outputEndSec);
      if (alpha) {
        parts.push(`alpha='${alpha}'`);
      }
    }

    return parts.join(":");
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
