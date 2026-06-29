import { spawn } from "node:child_process";
import { resolveFfmpegBins } from "./ffmpeg-bin.js";

const LOUDNORM_JSON_RE = /\{[\s\S]*"input_i"[\s\S]*\}/;

/**
 * Measure integrated loudness (LUFS) via FFmpeg loudnorm print_format=json.
 * Ported from video-modifier audio-mix patterns.
 */
export async function measureLoudness(audioPath, {
  targetLufs = -16,
  truePeak = -1.5,
  lra = 11,
} = {}) {
  const { ffmpeg } = resolveFfmpegBins();
  const filter = `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${lra}:print_format=json`;

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-hide_banner",
      "-i",
      audioPath,
      "-af",
      filter,
      "-f",
      "null",
      "-",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `measureLoudness failed (code ${code})`));
        return;
      }

      const match = stderr.match(LOUDNORM_JSON_RE);
      if (!match) {
        reject(new Error("Nie znaleziono JSON loudnorm w wyjściu FFmpeg"));
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(match[0]);
      } catch (error) {
        reject(new Error(`Nieprawidłowy JSON loudnorm: ${error.message}`));
        return;
      }

      const integratedLufs = Number.parseFloat(parsed.input_i);
      const truePeakDb = Number.parseFloat(parsed.input_tp);
      const measuredLra = Number.parseFloat(parsed.input_lra);
      const threshold = Number.parseFloat(parsed.input_thresh);
      const targetOffset = Number.parseFloat(parsed.target_offset);

      if (!Number.isFinite(integratedLufs)) {
        reject(new Error("Brak pola input_i w wyniku loudnorm"));
        return;
      }

      resolve({
        integratedLufs,
        truePeakDb: Number.isFinite(truePeakDb) ? truePeakDb : null,
        lra: Number.isFinite(measuredLra) ? measuredLra : null,
        threshold: Number.isFinite(threshold) ? threshold : null,
        targetOffset: Number.isFinite(targetOffset) ? targetOffset : null,
      });
    });
  });
}
