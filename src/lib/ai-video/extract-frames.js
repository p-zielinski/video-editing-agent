import fs from "node:fs";
import path from "node:path";
import { runFfmpeg, probeDuration } from "../ffmpeg.js";

/**
 * Extract a single PNG frame from video at timestamp.
 * @param {{ sourcePath: string, timestampSec: number, outputPath: string }} params
 */
export async function extractFramePng({ sourcePath, timestampSec, outputPath }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const ts = Math.max(0, timestampSec);
  await runFfmpeg(
    [
      "-y",
      "-ss", String(ts),
      "-i", sourcePath,
      "-frames:v", "1",
      "-q:v", "2",
      outputPath,
    ],
    { label: "extract frame PNG" },
  );
  return outputPath;
}

/**
 * Read PNG as raw base64 (no data-uri prefix) for Kling API.
 * @param {string} pngPath
 * @returns {string}
 */
export function readImageBase64(pngPath) {
  return fs.readFileSync(pngPath).toString("base64");
}

/**
 * Normalize generated clip to target canvas (1080x1920 for 9:16).
 */
export async function normalizeHookVideo({ inputPath, outputPath, width, height }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await runFfmpeg(
    [
      "-y",
      "-i", inputPath,
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-ar", "48000",
      "-ac", "2",
      outputPath,
    ],
    { label: "normalize AI hook video" },
  );
  const durationSec = await probeDuration(outputPath);
  return { outputPath, durationSec };
}
