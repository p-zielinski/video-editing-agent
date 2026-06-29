import { buildTechniqueFilter } from "./technique-to-ffmpeg.js";
import { findCutMidSentenceAtBoundary } from "./ffmpeg-concat.js";

const AUDIO_ONLY_TECHNIQUES = new Set(["music_swell", "music_drop", "silence_beat"]);
const CONCAT_DEFERRED_TECHNIQUES = new Set([
  "crossfade",
]);
const CONCAT_HANDLED_TECHNIQUES = new Set([
  "cut_on_beat",
]);

/**
 * Apply creativeMoments techniques to video via filter_complex segments.
 */
export async function applyCreativeMoments(inputPath, outputPath, {
  moments = [],
  encodeProfile,
  dimensions,
  spatialIndex,
  context,
  segments,
}) {
  const warnings = [];
  const supported = [];

  const boundaryCutMidSentence = findCutMidSentenceAtBoundary(moments, segments);
  if (boundaryCutMidSentence) {
    warnings.push({
      code: "CUT_MID_SENTENCE_ACK",
      techniqueId: "cut_mid_sentence",
      message: `retention pulse at segment join ${boundaryCutMidSentence.joinSec.toFixed(3)}s`,
      boundaryIndex: boundaryCutMidSentence.boundaryIndex,
      joinSec: boundaryCutMidSentence.joinSec,
    });
  }

  for (const moment of moments) {
    if (AUDIO_ONLY_TECHNIQUES.has(moment.techniqueId)) {
      warnings.push({
        code: "TECHNIQUE_AUDIO_ONLY",
        techniqueId: moment.techniqueId,
        message: `${moment.techniqueId} — technika audio-only, nie renderowana w pass wideo`,
      });
      continue;
    }
    if (CONCAT_DEFERRED_TECHNIQUES.has(moment.techniqueId)) {
      warnings.push({
        code: "TECHNIQUE_DEFERRED_CONCAT",
        techniqueId: moment.techniqueId,
        message: `${moment.techniqueId} — technika montażu na granicy segmentów; wymaga obsługi concat/xfade`,
      });
      continue;
    }
    if (CONCAT_HANDLED_TECHNIQUES.has(moment.techniqueId)) {
      continue;
    }
    supported.push(moment);
  }

  if (supported.length === 0) {
    const { copyFileSync } = await import("node:fs");
    copyFileSync(inputPath, outputPath);
    return { warnings };
  }

  const filterParts = [];
  let labelIn = "[0:v]";

  for (let i = 0; i < supported.length; i += 1) {
    const moment = supported[i];
    const nextLabel = `[v${i}]`;
    const built = buildTechniqueFilter(moment, {
      dimensions,
      spatialIndex,
      context,
      inputLabel: labelIn,
      outputLabel: nextLabel,
    });
    if (built.filter) {
      filterParts.push(built.filter);
      labelIn = built.outputLabel;
    } else if (built.deferred === "concat") {
      warnings.push({
        code: "TECHNIQUE_DEFERRED_CONCAT",
        techniqueId: moment.techniqueId,
        message: `${moment.techniqueId} — technika montażu na granicy segmentów; wymaga obsługi concat/xfade`,
      });
    } else if (built.delegatesTo === "graphics") {
      warnings.push({
        code: "TECHNIQUE_DELEGATED_GRAPHICS",
        techniqueId: moment.techniqueId,
        message: built.warning ?? `${moment.techniqueId} — delegacja do pass overlay`,
      });
    } else {
      warnings.push({
        code: "TECHNIQUE_NO_OP",
        techniqueId: moment.techniqueId,
        message: built.warning ?? `${moment.techniqueId} — brak filtra wideo (obsługa w innej warstwie lub deferred)`,
      });
    }
  }

  const finalVideoLabel = labelIn;

  if (filterParts.length === 0) {
    const { copyFileSync } = await import("node:fs");
    copyFileSync(inputPath, outputPath);
    return { warnings };
  }

  const { runFfmpeg } = await import("../lib/ffmpeg.js");

  try {
    await runFfmpeg(
      [
        "-y",
        "-i", inputPath,
        "-filter_complex", filterParts.join(";"),
        "-map", finalVideoLabel,
        "-map", "0:a?",
        "-c:v", encodeProfile.videoCodec,
        "-preset", encodeProfile.preset,
        "-crf", String(encodeProfile.crf),
        "-c:a", "copy",
        outputPath,
      ],
      { label: "creative moments" },
    );
  } catch (error) {
    warnings.push({
      code: "CREATIVE_FALLBACK",
      message: error.message,
    });
    const { copyFileSync } = await import("node:fs");
    copyFileSync(inputPath, outputPath);
  }

  return { warnings };
}
