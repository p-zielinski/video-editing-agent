import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFfmpeg } from "../lib/ffmpeg.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LUT_CATALOG = path.join(ROOT, "assets", "luts", "catalog.json");

function resolveLutPath(lutId) {
  if (!lutId || !fs.existsSync(LUT_CATALOG)) {
    return null;
  }
  const catalog = JSON.parse(fs.readFileSync(LUT_CATALOG, "utf8"));
  const entry = catalog.luts?.find((l) => l.lutId === lutId);
  if (!entry?.fileName) {
    return null;
  }
  const lutPath = path.join(ROOT, "assets", "luts", entry.fileName);
  return fs.existsSync(lutPath) ? lutPath : null;
}

/**
 * Build FFmpeg video filter chain from colorGrade object.
 */
export function buildColorGradeFilters(colorGrade) {
  if (!colorGrade) {
    return [];
  }

  const filters = [];
  const eqParts = [];
  if (colorGrade.exposure != null) {
    eqParts.push(`brightness=${colorGrade.exposure}`);
  }
  if (colorGrade.contrast != null) {
    eqParts.push(`contrast=${1 + colorGrade.contrast}`);
  }
  if (colorGrade.saturation != null) {
    eqParts.push(`saturation=${1 + colorGrade.saturation}`);
  }
  if (eqParts.length > 0) {
    filters.push(`eq=${eqParts.join(":")}`);
  }

  const lutPath = resolveLutPath(colorGrade.lutId);
  if (lutPath) {
    const escaped = lutPath.replace(/:/g, "\\:");
    filters.push(`lut3d=file='${escaped}'`);
  }

  return filters;
}

/**
 * Apply colorGrade via eq and optional lut3d.
 */
export async function applyColorGrade(inputPath, outputPath, {
  colorGrade,
  encodeProfile,
  runFfmpegFn = runFfmpeg,
}) {
  if (!colorGrade) {
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  const filters = buildColorGradeFilters(colorGrade);

  if (filters.length === 0) {
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  await runFfmpegFn(
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
    { label: "color grade" },
  );

  return outputPath;
}
