import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

export const THUMBNAIL_DIMENSIONS = {
  "16:9": { w: 1280, h: 720 },
  "9:16": { w: 1080, h: 1920 },
};

const SAFE_ZONE = {
  "16:9": { marginX: 0.08, marginY: 0.1, textBottomRatio: 0.72 },
  "9:16": { marginX: 0.1, marginY: 0.12, textBottomRatio: 0.68 },
};

export function escapeSvgText(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function computeThumbnailFontSize(headline, format, width) {
  const words = headline.trim().split(/\s+/).filter(Boolean);
  const longestWord = words.reduce((max, word) => Math.max(max, word.length), 1);
  const base = format === "9:16" ? width * 0.09 : width * 0.085;
  const wordScale = Math.min(1, 8 / longestWord);
  const lineScale = Math.min(1, 5 / Math.max(words.length, 1));
  return Math.round(base * wordScale * lineScale);
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
  const fontSize = computeThumbnailFontSize(headline, format, width);
  const marginX = Math.round(width * safe.marginX);
  const textY = Math.round(height * safe.textBottomRatio);
  const escaped = escapeSvgText(headline.toUpperCase());

  const lines = escaped.split(/\s+/);
  const tspans = lines.map((word, index) =>
    `<tspan x="${marginX}" dy="${index === 0 ? 0 : Math.round(fontSize * 1.05)}">${word}</tspan>`,
  ).join("");

  const barHeight = style === "frame_text_accent" ? Math.round(fontSize * 1.8) : 0;
  const barY = textY - Math.round(fontSize * 0.35);
  const bar = style === "frame_text_accent"
    ? `<rect x="0" y="${barY}" width="${width}" height="${barHeight}" fill="${accentColor}" opacity="0.92"/>`
    : "";

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  ${bar}
  <text x="${marginX}" y="${textY}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800" fill="#FFFFFF" stroke="#000000" stroke-width="${Math.max(3, Math.round(fontSize * 0.08))}" paint-order="stroke" text-anchor="start">
    ${tspans}
  </text>
</svg>`;
}

export function resolveThumbnailDimensions(format) {
  return THUMBNAIL_DIMENSIONS[format] ?? THUMBNAIL_DIMENSIONS["16:9"];
}

/**
 * Compute extract region so a face (xywh normalized) lands in the right third
 * when text overlay sits bottom-left.
 */
export function computeFaceAwareExtract({
  srcWidth,
  srcHeight,
  faceBbox,
  targetW,
  targetH,
  targetFaceX = 0.72,
  targetFaceY = 0.38,
}) {
  if (!faceBbox || faceBbox.length < 4 || srcWidth <= 0 || srcHeight <= 0) {
    return null;
  }

  const [x, y, w, h] = faceBbox;
  const faceCenterX = (x + w / 2) * srcWidth;
  const faceCenterY = (y + h / 2) * srcHeight;
  const scale = Math.max(targetW / srcWidth, targetH / srcHeight);
  const cropW = targetW / scale;
  const cropH = targetH / scale;

  let left = Math.round(faceCenterX - targetFaceX * cropW);
  let top = Math.round(faceCenterY - targetFaceY * cropH);
  left = Math.max(0, Math.min(Math.round(srcWidth - cropW), left));
  top = Math.max(0, Math.min(Math.round(srcHeight - cropH), top));

  return {
    left,
    top,
    width: Math.round(cropW),
    height: Math.round(cropH),
  };
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
}) {
  const { w, h } = resolveThumbnailDimensions(format);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const sourceMeta = await sharp(framePath).metadata();
  const srcWidth = sourceMeta.width ?? w;
  const srcHeight = sourceMeta.height ?? h;
  const extract = computeFaceAwareExtract({
    srcWidth,
    srcHeight,
    faceBbox,
    targetW: w,
    targetH: h,
  });

  let pipeline = sharp(framePath);
  if (extract) {
    pipeline = pipeline.extract(extract).resize(w, h, { fit: "fill" });
  } else {
    pipeline = pipeline.resize(w, h, { fit: "cover", position: "centre" });
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
