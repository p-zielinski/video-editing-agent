import fs from "node:fs";
import path from "node:path";
import { probeDuration, runFfmpeg } from "./ffmpeg.js";

const DEFAULT_PROXY_MAX_BYTES = 180 * 1024 * 1024;
const DEFAULT_PROXY_HEIGHT = 720;
const DEFAULT_CHUNK_DURATION_SEC = 300;
const DEFAULT_MAX_SINGLE_DURATION_SEC = 1200;
const DEFAULT_MIN_DURATION_SEC = 4;
/** Soft cap before Node Blob / memory issues (~2 GiB). */
const HARD_MEMORY_SAFE_BYTES = Math.floor(1.8 * 1024 * 1024 * 1024);

export function resolveTwelveLabsMinDurationSec(env = process.env) {
  const parsed = Number.parseFloat(env.TWELVELABS_MIN_DURATION_SEC ?? String(DEFAULT_MIN_DURATION_SEC));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_DURATION_SEC;
}

export function resolveTwelveLabsProxyMaxBytes(env = process.env) {
  const parsed = Number.parseInt(env.TWELVELABS_PROXY_MAX_BYTES ?? String(DEFAULT_PROXY_MAX_BYTES), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROXY_MAX_BYTES;
}

export function resolveTwelveLabsProxyHeight(env = process.env) {
  const parsed = Number.parseInt(env.TWELVELABS_PROXY_HEIGHT ?? String(DEFAULT_PROXY_HEIGHT), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROXY_HEIGHT;
}

export function resolveTwelveLabsChunkDurationSec(env = process.env) {
  const parsed = Number.parseFloat(env.TWELVELABS_CHUNK_DURATION_SEC ?? String(DEFAULT_CHUNK_DURATION_SEC));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHUNK_DURATION_SEC;
}

export function resolveTwelveLabsMaxSingleDurationSec(env = process.env) {
  const parsed = Number.parseFloat(
    env.TWELVELABS_MAX_SINGLE_DURATION_SEC ?? String(DEFAULT_MAX_SINGLE_DURATION_SEC),
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SINGLE_DURATION_SEC;
}

export function twelvelabsProxyPath(workDir, clipId) {
  return path.join(workDir, "twelvelabs-proxy", `${clipId}.mp4`);
}

export function twelvelabsChunkDir(workDir, clipId) {
  return path.join(workDir, "twelvelabs-chunks", clipId);
}

/**
 * @returns {{ needsProxy: boolean, needsChunking: boolean, sizeBytes: number, durationSec: number | null }}
 */
export function assessTwelveLabsUploadNeeds({
  sourcePath,
  durationSec = null,
  maxBytes = resolveTwelveLabsProxyMaxBytes(),
  maxSingleDurationSec = resolveTwelveLabsMaxSingleDurationSec(),
}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`TwelveLabs: brak pliku źródłowego: ${sourcePath}`);
  }
  const sizeBytes = fs.statSync(sourcePath).size;
  const needsProxy = sizeBytes > maxBytes || sizeBytes > HARD_MEMORY_SAFE_BYTES;
  const needsChunking = (durationSec != null && durationSec > maxSingleDurationSec)
    || sizeBytes > HARD_MEMORY_SAFE_BYTES;
  return { needsProxy, needsChunking, sizeBytes, durationSec };
}

function proxyCacheFresh(sourcePath, proxyPath) {
  if (!fs.existsSync(proxyPath)) {
    return false;
  }
  const sourceStat = fs.statSync(sourcePath);
  const proxyStat = fs.statSync(proxyPath);
  return proxyStat.mtimeMs >= sourceStat.mtimeMs && proxyStat.size > 0;
}

/**
 * Ensure upload file is under maxBytes via 720p proxy (with aggressive retry).
 * @returns {{ uploadPath: string, proxied: boolean, sizeBytes: number, stillTooLarge: boolean }}
 */
export async function prepareVideoForTwelveLabsUpload({
  sourcePath,
  workDir,
  clipId,
  maxBytes = resolveTwelveLabsProxyMaxBytes(),
  proxyHeight = resolveTwelveLabsProxyHeight(),
  durationSec = null,
  runFfmpegFn = runFfmpeg,
}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`TwelveLabs: brak pliku źródłowego: ${sourcePath}`);
  }

  const sourceSize = fs.statSync(sourcePath).size;
  if (sourceSize <= maxBytes && sourceSize <= HARD_MEMORY_SAFE_BYTES) {
    return {
      uploadPath: sourcePath,
      proxied: false,
      sizeBytes: sourceSize,
      stillTooLarge: false,
    };
  }

  const outPath = twelvelabsProxyPath(workDir, clipId);
  const resolvedDuration = durationSec
    ?? (await probeDuration(sourcePath).catch(() => null));

  if (proxyCacheFresh(sourcePath, outPath) && fs.statSync(outPath).size <= maxBytes) {
    return {
      uploadPath: outPath,
      proxied: true,
      sizeBytes: fs.statSync(outPath).size,
      stillTooLarge: false,
    };
  }

  const attempts = [
    { height: proxyHeight, crf: 28 },
    { height: proxyHeight, crf: 32 },
    { height: Math.min(480, proxyHeight), crf: 32 },
  ];

  for (const attempt of attempts) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await runFfmpegFn(
      [
        "-y",
        "-i",
        sourcePath,
        "-vf",
        `scale=-2:${attempt.height}`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        String(attempt.crf),
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        outPath,
      ],
      {
        label: `twelvelabs proxy ${attempt.height}p crf${attempt.crf}`,
        heartbeatSec: 25,
        durationSec: resolvedDuration ?? undefined,
      },
    );

    const sizeBytes = fs.statSync(outPath).size;
    if (sizeBytes <= maxBytes) {
      return {
        uploadPath: outPath,
        proxied: true,
        sizeBytes,
        stillTooLarge: false,
      };
    }
  }

  const sizeBytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : sourceSize;
  return {
    uploadPath: fs.existsSync(outPath) ? outPath : sourcePath,
    proxied: fs.existsSync(outPath),
    sizeBytes,
    stillTooLarge: sizeBytes > maxBytes,
  };
}

/**
 * Split video into temporal segments for TwelveLabs indexing.
 * @returns {Promise<Array<{ path: string, startSec: number, endSec: number, index: number }>>}
 */
export async function splitVideoForTwelveLabsChunks({
  sourcePath,
  workDir,
  clipId,
  chunkDurationSec = resolveTwelveLabsChunkDurationSec(),
  durationSec = null,
  proxyHeight = resolveTwelveLabsProxyHeight(),
  runFfmpegFn = runFfmpeg,
}) {
  const totalDuration = durationSec ?? await probeDuration(sourcePath);
  const chunkCount = Math.max(1, Math.ceil(totalDuration / chunkDurationSec));
  const dir = twelvelabsChunkDir(workDir, clipId);
  fs.mkdirSync(dir, { recursive: true });

  const chunks = [];
  for (let i = 0; i < chunkCount; i += 1) {
    const startSec = i * chunkDurationSec;
    const endSec = Math.min(totalDuration, (i + 1) * chunkDurationSec);
    const chunkPath = path.join(dir, `seg-${String(i).padStart(3, "0")}.mp4`);

    await runFfmpegFn(
      [
        "-y",
        "-ss",
        String(startSec),
        "-t",
        String(endSec - startSec),
        "-i",
        sourcePath,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "28",
        "-vf",
        `scale=-2:${proxyHeight}`,
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        chunkPath,
      ],
      {
        label: `twelvelabs chunk ${i + 1}/${chunkCount}`,
        heartbeatSec: 25,
        durationSec: endSec - startSec,
      },
    );

    chunks.push({
      path: chunkPath,
      startSec,
      endSec,
      index: i,
    });
  }

  return chunks;
}
