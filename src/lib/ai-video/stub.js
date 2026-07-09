import fs from "node:fs";
import path from "node:path";
import { runFfmpeg, probeDuration } from "../ffmpeg.js";

/**
 * Generate a placeholder hook clip (lavfi) for CI/dev without Kling API.
 */
export async function generateStubHookVideo({
  outputPath,
  durationSec = 5,
  width = 1080,
  height = 1920,
}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await runFfmpeg(
    [
      "-y",
      "-f", "lavfi",
      "-i", `color=c=0x1a1a2e:s=${width}x${height}:d=${durationSec}:r=24`,
      "-f", "lavfi",
      "-i", `anullsrc=r=48000:cl=stereo`,
      "-t", String(durationSec),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      outputPath,
    ],
    { label: "stub AI hook video" },
  );
  const duration = await probeDuration(outputPath);
  return { outputPath, durationSec: duration, provider: "stub" };
}
