import fs from "node:fs";
import path from "node:path";
import { runFfmpeg, probeDuration } from "./ffmpeg.js";

const WHISPER_MAX_BYTES = 24 * 1024 * 1024;
const WHISPER_LOUDNORM = "loudnorm=I=-18:TP=-1.5:LRA=11:linear=true";
/** Max duration drift (sec) before pad/trim to keep Whisper word timings on source timeline. */
export const ENHANCEMENT_DURATION_ALIGN_TOLERANCE_SEC = 0.02;

export function whisperAudioPath(workDir, clipId) {
  return path.join(workDir, "audio", "whisper", `${clipId}.mp3`);
}

export function analysisAudioPath(workDir, clipId) {
  return path.join(workDir, "audio", "analysis", `${clipId}.wav`);
}

/** 48 kHz mono PCM input for denoise providers (not the 22050 analysis rate). */
export function enhancementInputAudioPath(workDir, clipId) {
  return path.join(workDir, "audio", "enhancement", `${clipId}.wav`);
}

/**
 * Extract/loudnorm media (video or WAV) to Whisper MP3.
 * Prefer enhanced WAV via resolveWhisperMediaPath / resolveEnhancedAudioForWhisper upstream
 * so word timings stay on the source timeline (enhancement pad/trims to source duration).
 */
export async function extractAudioForWhisper(mediaPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  await runFfmpeg(
    [
      "-y",
      "-i",
      mediaPath,
      "-vn",
      "-af",
      WHISPER_LOUDNORM,
      "-acodec",
      "libmp3lame",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-ac",
      "1",
      outputPath,
    ],
    { label: "ekstrakcja audio → mp3 (whisper, loudnorm -18 LUFS)", heartbeatSec: 25 },
  );

  if (fs.statSync(outputPath).size > WHISPER_MAX_BYTES) {
    await runFfmpeg(
      [
        "-y",
        "-i",
        mediaPath,
        "-vn",
        "-af",
        WHISPER_LOUDNORM,
        "-acodec",
        "libmp3lame",
        "-b:a",
        "64k",
        "-ar",
        "44100",
        "-ac",
        "1",
        outputPath,
      ],
      { label: "kompresja audio do 64 kbps (limit whisper)", heartbeatSec: 25 },
    );
  }

  if (fs.statSync(outputPath).size > WHISPER_MAX_BYTES) {
    throw new Error(
      "Plik audio po kompresji nadal przekracza limit Whisper (25 MB). Użyj krótszego nagrania lub chunkingu.",
    );
  }
}

export async function extractAudioForAnalysis(videoPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  await runFfmpeg(
    [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "22050",
      "-ac",
      "1",
      outputPath,
    ],
    { label: "ekstrakcja audio → wav (analiza librosa)", heartbeatSec: 25 },
  );
}

/**
 * Extract 48 kHz mono PCM for denoise / enhancement providers.
 */
export async function extractAudioForEnhancement(videoPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  await runFfmpeg(
    [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "1",
      outputPath,
    ],
    { label: "ekstrakcja audio → wav 48 kHz (enhancement)", heartbeatSec: 25 },
  );
}

/**
 * Pad or trim audio so duration matches targetSec (source timeline alignment for Whisper/render).
 * Enhancement providers may slightly change length; pad/trim keeps word timings aligned.
 * @returns {{ durationDeltaMs: number, aligned: boolean }}
 */
export async function alignAudioDuration(inputPath, outputPath, targetSec) {
  const actualSec = await probeDuration(inputPath);
  const deltaSec = actualSec - targetSec;
  const durationDeltaMs = Math.round(deltaSec * 1000);

  if (Math.abs(deltaSec) <= ENHANCEMENT_DURATION_ALIGN_TOLERANCE_SEC) {
    if (path.resolve(inputPath) !== path.resolve(outputPath)) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.copyFileSync(inputPath, outputPath);
    }
    return { durationDeltaMs, aligned: false };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (deltaSec > 0) {
    await runFfmpeg(
      [
        "-y",
        "-i",
        inputPath,
        "-af",
        `atrim=0:${targetSec}`,
        "-ar",
        "48000",
        "-ac",
        "1",
        outputPath,
      ],
      { label: "align enhanced audio (trim to source duration)" },
    );
  } else {
    await runFfmpeg(
      [
        "-y",
        "-i",
        inputPath,
        "-af",
        `apad=whole_dur=${targetSec}`,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-t",
        String(targetSec),
        outputPath,
      ],
      { label: "align enhanced audio (pad to source duration)" },
    );
  }

  return { durationDeltaMs, aligned: true };
}

/**
 * Dzieli długie nagranie na chunki audio dla Whisper (limit 25 MB).
 * Zwraca listę { path, startSec, endSec }.
 */
export async function extractAudioChunksForWhisper(
  mediaPath,
  workDir,
  { clipId, chunkDurationSec = 600 } = {},
) {
  if (!clipId) {
    throw new Error("extractAudioChunksForWhisper requires clipId for clip-scoped chunk paths");
  }

  const durationSec = await probeDuration(mediaPath);
  const chunks = [];
  const chunkCount = Math.ceil(durationSec / chunkDurationSec);
  const whisperDir = path.join(workDir, "audio", "whisper");
  fs.mkdirSync(whisperDir, { recursive: true });

  for (let i = 0; i < chunkCount; i += 1) {
    const startSec = i * chunkDurationSec;
    const endSec = Math.min(durationSec, (i + 1) * chunkDurationSec);
    const chunkPath = path.join(whisperDir, `chunk-${clipId}-${String(i).padStart(3, "0")}.mp3`);

    await runFfmpeg(
      [
        "-y",
        "-ss",
        String(startSec),
        "-t",
        String(endSec - startSec),
        "-i",
        mediaPath,
        "-vn",
        "-af",
        WHISPER_LOUDNORM,
        "-acodec",
        "libmp3lame",
        "-b:a",
        "64k",
        "-ar",
        "44100",
        "-ac",
        "1",
        chunkPath,
      ],
      { label: `audio chunk ${i + 1}/${chunkCount}` },
    );

    chunks.push({ path: chunkPath, startSec, endSec });
  }

  return chunks;
}
