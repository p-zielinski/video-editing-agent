import { runFfmpeg } from "../ffmpeg.js";

export const POLISH_PRESET_FILTERS = {
  none: null,
  repair_only: "highpass=f=80,afftdn=nr=12:nf=-25",
  engagement_polish: [
    "highpass=f=80",
    "equalizer=f=3000:width_type=o:width=2:g=1.5",
    "acompressor=threshold=-18dB:ratio=2.5:attack=20:release=200:makeup=1",
  ].join(","),
  podcast_polish: [
    "highpass=f=80",
    "equalizer=f=3000:width_type=o:width=2:g=1.5",
    "acompressor=threshold=-18dB:ratio=2.5:attack=20:release=200:makeup=1",
  ].join(","),
};

export function resolvePolishPreset(decision) {
  const preset = decision?.polishPreset ?? "none";
  if (preset === "none") {
    return null;
  }
  return POLISH_PRESET_FILTERS[preset] ?? POLISH_PRESET_FILTERS.engagement_polish;
}

export function shouldSkipPolishForWind(perClipAnalysis, clipId, windThreshold = 0.45) {
  const analysis = Array.isArray(perClipAnalysis)
    ? perClipAnalysis.find((entry) => entry.clipId === clipId)
    : null;
  const windScore = analysis?.audioQuality?.windScore ?? 0;
  return windScore >= windThreshold;
}

export async function applyDspPolish(inputPath, outputPath, preset) {
  const filter = POLISH_PRESET_FILTERS[preset] ?? POLISH_PRESET_FILTERS.engagement_polish;
  if (!filter) {
    throw new Error(`Nieznany preset DSP: ${preset}`);
  }

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
  ], { label: `DSP polish (${preset})` });

  return { preset, filter };
}
