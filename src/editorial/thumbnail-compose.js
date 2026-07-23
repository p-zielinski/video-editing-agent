import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { subjectFitsInCropWindow, unionAnchorBbox } from "../render/reframe.js";

export const THUMBNAIL_DIMENSIONS = {
  "16:9": { w: 1280, h: 720 },
  "9:16": { w: 1080, h: 1920 },
};

const SAFE_ZONE = {
  "16:9": { marginX: 0.05, marginY: 0.06, textBottomRatio: 0.94, maxTextWidthRatio: 0.9 },
  "9:16": { marginX: 0.07, marginY: 0.08, textBottomRatio: 0.86, maxTextWidthRatio: 0.86 },
};

const SUBJECT_LABEL_RE = /^(face|head|human face|person|human|man|woman|boy|girl|people|adult|child)$/i;
const DOG_LABEL_RE = /dog|puppy|pet/i;

export function escapeSvgText(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Pack headline into ≤ maxLines (never one-word-per-line for 3+ words).
 * For 2 lines, picks the character-balanced split.
 */
export function wrapThumbnailHeadline(headline, maxLines = 2) {
  const words = String(headline)
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  if (maxLines <= 1 || words.length === 1) {
    return [words.join(" ")];
  }

  if (maxLines === 2) {
    let best = [words.join(" ")];
    let bestScore = Number.POSITIVE_INFINITY;
    for (let splitAt = 1; splitAt < words.length; splitAt += 1) {
      const left = words.slice(0, splitAt).join(" ");
      const right = words.slice(splitAt).join(" ");
      const balance = Math.abs(left.length - right.length);
      // Prefer not leaving a single ultra-short orphan on line 1 when 4+ words.
      const orphanPenalty = splitAt === 1 && words.length >= 4 ? 3 : 0;
      const score = balance + orphanPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = [left, right];
      }
    }
    return best;
  }

  const lineCount = Math.min(maxLines, words.length);
  const lines = Array.from({ length: lineCount }, () => []);
  const wordsPerLine = Math.ceil(words.length / lineCount);
  for (let i = 0; i < words.length; i += 1) {
    lines[Math.min(lineCount - 1, Math.floor(i / wordsPerLine))].push(words[i]);
  }
  return lines.map((parts) => parts.join(" ")).filter(Boolean);
}

export function computeThumbnailFontSize(headline, format, width, lines = null) {
  const wrapped = lines ?? wrapThumbnailHeadline(headline, 2);
  const longest = wrapped.reduce((max, line) => Math.max(max, line.length), 1);
  const base = format === "9:16" ? width * 0.07 : width * 0.058;
  const charScale = Math.min(1, 12 / longest);
  const lineScale = wrapped.length > 1 ? 0.9 : 1;
  return Math.max(28, Math.round(base * charScale * lineScale));
}

export function buildThumbnailTextSvg({
  headline,
  format,
  width,
  height,
  style = "frame_plus_text",
  accentColor = "#FF3B30",
}) {
  const safe = SAFE_ZONE[format] ?? SAFE_ZONE["16:9"];
  const lines = wrapThumbnailHeadline(headline, 2);
  if (lines.length === 0) {
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }

  const fontSize = computeThumbnailFontSize(headline, format, width, lines);
  const marginX = Math.round(width * safe.marginX);
  const lineHeight = Math.round(fontSize * 1.08);
  const padTop = Math.round(fontSize * 0.42);
  const padBottom = Math.round(fontSize * 0.55);
  const padX = Math.round(fontSize * 0.5);
  const contentHeight = Math.max(lineHeight, (lines.length - 1) * lineHeight + fontSize);
  const barHeight = contentHeight + padTop + padBottom;
  const barBottom = Math.round(height * safe.textBottomRatio);
  const barY = Math.max(0, Math.min(height - barHeight, barBottom - barHeight));
  const firstBaseline = barY + padTop + Math.round(fontSize * 0.78);

  const tspans = lines.map((line, index) => {
    const escaped = escapeSvgText(line);
    const dy = index === 0 ? 0 : lineHeight;
    return `<tspan x="${marginX + padX}" dy="${dy}">${escaped}</tspan>`;
  }).join("");

  const approxCharW = fontSize * 0.62;
  const longestChars = lines.reduce((max, line) => Math.max(max, line.length), 1);
  const barWidth = Math.min(
    width,
    Math.round(marginX + padX * 2 + longestChars * approxCharW + padX),
  );

  const bar = style === "frame_text_accent"
    ? `<rect x="0" y="${barY}" width="${width}" height="${barHeight}" fill="${accentColor}" opacity="0.94"/>`
    : style === "frame_plus_text"
      ? `<rect x="${Math.max(0, marginX - Math.round(padX * 0.2))}" y="${barY}" rx="12" ry="12" width="${Math.min(width - marginX, barWidth)}" height="${barHeight}" fill="#000000" opacity="0.58"/>`
      : "";

  const strokeW = Math.max(3, Math.round(fontSize * 0.07));
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  ${bar}
  <text x="${marginX + padX}" y="${firstBaseline}" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800" fill="#FFFFFF" stroke="#000000" stroke-width="${strokeW}" paint-order="stroke fill" text-anchor="start">
    ${tspans}
  </text>
</svg>`;
}

export function resolveThumbnailDimensions(format) {
  return THUMBNAIL_DIMENSIONS[format] ?? THUMBNAIL_DIMENSIONS["16:9"];
}

/**
 * Prefer dimensions that match decoded orientation when catalog still has
 * landscape rotation metadata (e.g. 3840×2160 labeled, frames are 2160×3840).
 */
export function resolveThumbnailSourceDimensions({
  scene = null,
  clip = null,
  detections = [],
} = {}) {
  const catalogW = scene?.resolution?.w ?? clip?.resolution?.w ?? null;
  const catalogH = scene?.resolution?.h ?? clip?.resolution?.h ?? null;
  const fallback = {
    srcWidth: catalogW ?? 1080,
    srcHeight: catalogH ?? 1920,
  };
  if (!catalogW || !catalogH) {
    return fallback;
  }

  const pixelBoxes = detections
    .map((detection) => detection?.bbox)
    .filter((bbox) => Array.isArray(bbox) && bbox.some((value) => Number(value) > 1.05));
  if (pixelBoxes.length === 0) {
    return fallback;
  }

  const maxCoord = pixelBoxes.reduce((max, bbox) => Math.max(max, ...bbox.map(Number)), 0);
  // If any pixel coord exceeds catalog height but fits swapped portrait height, swap.
  if (maxCoord > catalogH + 1 && maxCoord <= Math.max(catalogW, catalogH) + 1 && catalogW > catalogH) {
    return { srcWidth: catalogH, srcHeight: catalogW };
  }
  if (maxCoord > catalogW + 1 && maxCoord <= Math.max(catalogW, catalogH) + 1 && catalogH > catalogW) {
    return { srcWidth: catalogH, srcHeight: catalogW };
  }
  return fallback;
}

export function clampNormalizedBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) {
    return null;
  }
  const [x0, y0, w0, h0] = bbox.map(Number);
  if ([x0, y0, w0, h0].some((value) => Number.isNaN(value))) {
    return null;
  }
  const x = Math.min(1, Math.max(0, x0));
  const y = Math.min(1, Math.max(0, y0));
  const w = Math.min(1 - x, Math.max(0, w0));
  const h = Math.min(1 - y, Math.max(0, h0));
  if (w <= 0.001 || h <= 0.001) {
    return null;
  }
  return [x, y, w, h];
}

function normalizePixelBbox(values, srcWidth, srcHeight) {
  const [a, b, c, d] = values;
  const fitsXywh = a + c <= srcWidth + 1 && b + d <= srcHeight + 1;
  if (fitsXywh) {
    return clampNormalizedBbox([a / srcWidth, b / srcHeight, c / srcWidth, d / srcHeight]);
  }
  if (c > a && d > b && c <= srcWidth + 1 && d <= srcHeight + 1) {
    return clampNormalizedBbox([
      a / srcWidth,
      b / srcHeight,
      (c - a) / srcWidth,
      (d - b) / srcHeight,
    ]);
  }
  return null;
}

/**
 * Normalize detection bbox to xywh 0–1 using actual frame dimensions.
 * Accepts already-normalized or pixel xywh / x1y1x2y2.
 * Falls back to swapped width/height when catalog rotation metadata is wrong.
 */
export function normalizeDetectionBboxToFrame(bbox, srcWidth, srcHeight) {
  if (!Array.isArray(bbox) || bbox.length < 4 || srcWidth <= 0 || srcHeight <= 0) {
    return null;
  }
  const values = bbox.map(Number);
  if (values.some((value) => Number.isNaN(value))) {
    return null;
  }

  const allNormalized = values.every((value) => value >= 0 && value <= 1.05);
  if (allNormalized) {
    return clampNormalizedBbox(values);
  }

  return normalizePixelBbox(values, srcWidth, srcHeight)
    ?? normalizePixelBbox(values, srcHeight, srcWidth)
    ?? clampNormalizedBbox([
      values[0] / srcWidth,
      values[1] / srcHeight,
      values[2] / srcWidth,
      values[3] / srcHeight,
    ]);
}

export function isSubjectDetection(detection) {
  const label = String(detection?.label ?? detection?.type ?? "").toLowerCase();
  if (!label) {
    return false;
  }
  if (detection?.type === "face" || SUBJECT_LABEL_RE.test(label) || label.includes("face")) {
    return true;
  }
  return DOG_LABEL_RE.test(label);
}

export function isDogDetection(detection) {
  return DOG_LABEL_RE.test(String(detection?.label ?? ""));
}

/**
 * Build subject union bbox near a timestamp from raw detections.
 */
export function resolveSubjectBboxNearTimestamp({
  detections = [],
  timestampSec = 0,
  srcWidth,
  srcHeight,
  maxDeltaSec = 2.5,
  sceneId = null,
}) {
  const scored = detections
    .filter((detection) => isSubjectDetection(detection))
    .filter((detection) => !sceneId || !detection.sceneId || detection.sceneId === sceneId)
    .map((detection) => {
      const bbox = normalizeDetectionBboxToFrame(detection.bbox, srcWidth, srcHeight);
      const delta = Math.abs((detection.timestampSec ?? 0) - timestampSec);
      return { detection, bbox, delta };
    })
    .filter((entry) => entry.bbox && entry.delta <= maxDeltaSec)
    .sort((a, b) => a.delta - b.delta || (b.detection.confidence ?? 0) - (a.detection.confidence ?? 0));

  if (scored.length === 0) {
    return null;
  }

  const nearestDelta = scored[0].delta;
  const near = scored.filter((entry) => entry.delta <= nearestDelta + 0.35);
  const union = unionAnchorBbox(near.map((entry) => ({ bbox: entry.bbox })));
  if (!union) {
    return near[0].bbox;
  }
  return clampNormalizedBbox([union.x, union.y, union.w, union.h]);
}

/**
 * Decide framing strategy for thumbnail extract.
 * Portrait→landscape: prefer blur_pad so context (e.g. dog) survives.
 */
export function resolveThumbnailFraming({
  srcWidth,
  srcHeight,
  targetW,
  targetH,
  subjectBbox = null,
}) {
  if (srcWidth <= 0 || srcHeight <= 0 || targetW <= 0 || targetH <= 0) {
    return { mode: "cover_center" };
  }

  const sourceAspect = srcWidth / srcHeight;
  const targetAspect = targetW / targetH;
  const clampedSubject = clampNormalizedBbox(subjectBbox);
  const fits = clampedSubject
    ? subjectFitsInCropWindow({
      unionBbox: {
        x: clampedSubject[0],
        y: clampedSubject[1],
        w: clampedSubject[2],
        h: clampedSubject[3],
      },
      sourceAspect,
      targetAspect,
      margin: 0.06,
    })
    : true;

  // Portrait source into landscape canvas — cover-crop on face kills context.
  if (sourceAspect < targetAspect - 0.08) {
    return { mode: "blur_pad", subjectBbox: clampedSubject };
  }

  if (clampedSubject && fits) {
    return { mode: "cover_subject", subjectBbox: clampedSubject };
  }

  if (clampedSubject && !fits) {
    return { mode: "blur_pad", subjectBbox: clampedSubject };
  }

  return { mode: "cover_center" };
}

/**
 * Cover extract placing subject center in frame (no extra zoom beyond aspect cover).
 */
export function computeSubjectAwareExtract({
  srcWidth,
  srcHeight,
  subjectBbox,
  targetW,
  targetH,
  targetSubjectX = 0.5,
  targetSubjectY = 0.42,
}) {
  const bbox = clampNormalizedBbox(subjectBbox);
  if (!bbox || srcWidth <= 0 || srcHeight <= 0) {
    return null;
  }

  const [x, y, w, h] = bbox;
  const subjectCenterX = (x + w / 2) * srcWidth;
  const subjectCenterY = (y + h / 2) * srcHeight;
  const scale = Math.max(targetW / srcWidth, targetH / srcHeight);
  const cropW = targetW / scale;
  const cropH = targetH / scale;

  let left = Math.round(subjectCenterX - targetSubjectX * cropW);
  let top = Math.round(subjectCenterY - targetSubjectY * cropH);
  left = Math.max(0, Math.min(Math.round(srcWidth - cropW), left));
  top = Math.max(0, Math.min(Math.round(srcHeight - cropH), top));

  return {
    left,
    top,
    width: Math.round(cropW),
    height: Math.round(cropH),
  };
}

/** @deprecated Use computeSubjectAwareExtract — kept for older tests/callers. */
export function computeFaceAwareExtract({
  srcWidth,
  srcHeight,
  faceBbox,
  targetW,
  targetH,
  targetFaceX = 0.5,
  targetFaceY = 0.42,
}) {
  return computeSubjectAwareExtract({
    srcWidth,
    srcHeight,
    subjectBbox: faceBbox,
    targetW,
    targetH,
    targetSubjectX: targetFaceX,
    targetSubjectY: targetFaceY,
  });
}

async function composeBlurPad({
  framePath,
  width,
  height,
  subjectBbox = null,
}) {
  let position = "centre";
  if (subjectBbox) {
    const cy = subjectBbox[1] + subjectBbox[3] / 2;
    if (cy < 0.38) {
      position = "north";
    } else if (cy > 0.62) {
      position = "south";
    }
  }

  const meta = await sharp(framePath).metadata();
  const srcW = meta.width ?? width;
  const srcH = meta.height ?? height;
  const scale = Math.min(width / srcW, height / srcH);
  const fgW = Math.max(1, Math.round(srcW * scale));
  const fgH = Math.max(1, Math.round(srcH * scale));
  const left = Math.round((width - fgW) / 2);
  const top = Math.round((height - fgH) / 2);

  const background = await sharp(framePath)
    .resize(width, height, { fit: "cover", position })
    .blur(32)
    .modulate({ brightness: 0.65, saturation: 0.85 })
    .toBuffer();

  const foreground = await sharp(framePath)
    .resize(fgW, fgH, { fit: "fill" })
    .toBuffer();

  return sharp(background).composite([{ input: foreground, left, top }]);
}

/**
 * Compose a thumbnail PNG from a source frame and optional text overlay.
 */
export async function composeThumbnail({
  framePath,
  headline = "",
  style = "frame_only",
  format = "16:9",
  outputPath,
  accentColor = "#FF3B30",
  faceBbox = null,
  subjectBbox = null,
}) {
  const { w, h } = resolveThumbnailDimensions(format);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const sourceMeta = await sharp(framePath).metadata();
  const srcWidth = sourceMeta.width ?? w;
  const srcHeight = sourceMeta.height ?? h;
  const resolvedSubject = clampNormalizedBbox(subjectBbox) ?? clampNormalizedBbox(faceBbox);
  const framing = resolveThumbnailFraming({
    srcWidth,
    srcHeight,
    targetW: w,
    targetH: h,
    subjectBbox: resolvedSubject,
  });

  let pipeline;
  if (framing.mode === "blur_pad") {
    // Materialize before text overlay — chaining .composite() can drop prior layers.
    const framed = await (await composeBlurPad({
      framePath,
      width: w,
      height: h,
      subjectBbox: framing.subjectBbox,
    })).png().toBuffer();
    pipeline = sharp(framed);
  } else if (framing.mode === "cover_subject") {
    const extract = computeSubjectAwareExtract({
      srcWidth,
      srcHeight,
      subjectBbox: framing.subjectBbox,
      targetW: w,
      targetH: h,
    });
    pipeline = extract
      ? sharp(framePath).extract(extract).resize(w, h, { fit: "fill" })
      : sharp(framePath).resize(w, h, { fit: "cover", position: "centre" });
  } else {
    pipeline = sharp(framePath).resize(w, h, { fit: "cover", position: "centre" });
  }

  if (style !== "frame_only" && headline.trim()) {
    const svg = buildThumbnailTextSvg({
      headline,
      format,
      width: w,
      height: h,
      style,
      accentColor,
    });
    pipeline = pipeline.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  }

  await pipeline.png().toFile(outputPath);
  return outputPath;
}
