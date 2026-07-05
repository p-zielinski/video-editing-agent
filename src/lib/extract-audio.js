import fs from "node:fs";
import path from "node:path";
import { runFfmpeg, probeDuration } from "./ffmpeg.js";

const WHISPER_MAX_BYTES = 24 * 1024 * 1024;
const WHISPER_LOUDNORM = "loudnorm=I=-18:TP=-1.5:LRA=11:linear=true";

export function whisperAudioPath(workDir, clipId) {
  return path.join(workDir, "audio", "whisper", `${clipId}.mp3`);
}

export function analysisAudioPath(workDir, clipId) {
  return path.join(workDir, "audio", "analysis", `${clipId}.wav`);
}

export async function extractAudioForWhisper(videoPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  await runFfmpeg(
    [
      "-y",
      "-i",
      videoPath,
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
        videoPath,
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
 * Dzieli długie nagranie na chunki audio dla Whisper (limit 25 MB).
 * Zwraca listę { path, startSec, endSec }.
 */
export async function extractAudioChunksForWhisper(
  videoPath,
  workDir,
  { clipId, chunkDurationSec = 600 } = {},
) {
  if (!clipId) {
    throw new Error("extractAudioChunksForWhisper requires clipId for clip-scoped chunk paths");
  }

  const durationSec = await probeDuration(videoPath);
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
        videoPath,
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
