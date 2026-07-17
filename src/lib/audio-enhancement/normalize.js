import { runFfmpeg } from "../ffmpeg.js";
import { measureLoudness } from "../measure-loudness.js";
import { buildLoudnormFilter } from "../../render/audio-mix.js";

export function clampGainDb(gainDb, min = -12, max = 12) {
  return Math.max(min, Math.min(max, gainDb));
}

export function resolveTargetDialogueLufs(decision, goodClipLufs = []) {
  if (Number.isFinite(decision?.targetDialogueLufs)) {
    return decision.targetDialogueLufs;
  }

  const finite = goodClipLufs.filter((value) => Number.isFinite(value));
  if (finite.length > 0) {
    const sorted = [...finite].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  return -18;
}

export async function applyLoudnessNormalization(inputPath, outputPath, targetLufs) {
  const measurement = await measureLoudness(inputPath, { targetLufs });
  const filter = buildLoudnormFilter(measurement, { targetLufs });
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-af",
    filter,
    "-ar",
    "48000",
    "-ac",
    "1",
    outputPath,
  ], { label: `normalizacja dialogu → ${targetLufs} LUFS` });
  const finalMeasurement = await measureLoudness(outputPath, { targetLufs });
  return {
    gainDb: clampGainDb(targetLufs - measurement.integratedLufs),
    finalIntegratedLufs: finalMeasurement.integratedLufs,
    beforeIntegratedLufs: measurement.integratedLufs,
  };
}
