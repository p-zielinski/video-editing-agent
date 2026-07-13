import fs from "node:fs";
import path from "node:path";
import { buildKlingAuthorizationHeader } from "./kling-credentials.js";
import { KLING_API_BASE } from "./types.js";

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 600_000;

export const DEFAULT_KLING_VIDEO_MODEL = "kling-v3";

export function resolveKlingVideoModel(env = process.env) {
  return env.KLING_VIDEO_MODEL ?? DEFAULT_KLING_VIDEO_MODEL;
}

function isKlingV3(modelName) {
  return /^kling-(?:v3|3(?:\.0)?)(?:$|[-/])/.test(modelName);
}

export function resolveKlingDurationString(durationSec, modelName) {
  const rounded = Math.max(3, Math.min(15, Math.round(durationSec)));
  if (isKlingV3(modelName)) {
    return String(rounded);
  }
  if (rounded <= 5) {
    return "5";
  }
  return "10";
}

export function buildKlingImage2VideoPayload({
  modelName,
  prompt,
  firstFrameBase64,
  lastFrameBase64,
  durationSec,
  aspectRatio,
  generateAudio,
}) {
  return {
    model_name: modelName,
    prompt,
    image: firstFrameBase64,
    image_tail: lastFrameBase64,
    mode: "pro",
    aspect_ratio: aspectRatio,
    duration: resolveKlingDurationString(durationSec, modelName),
    sound: generateAudio ? "on" : "off",
  };
}

function authHeaders(accessKey) {
  return {
    Authorization: buildKlingAuthorizationHeader(accessKey),
    "Content-Type": "application/json",
  };
}

async function parseJsonResponse(response) {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Kling API HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  if (body.code != null && body.code !== 0) {
    throw new Error(`Kling API error ${body.code}: ${body.message ?? JSON.stringify(body)}`);
  }
  return body;
}

/**
 * @param {object} params
 * @param {string} params.accessKey
 * @param {string} params.prompt
 * @param {string} params.firstFrameBase64
 * @param {string} params.lastFrameBase64
 * @param {number} params.durationSec
 * @param {string} [params.aspectRatio]
 * @param {boolean} [params.generateAudio]
 * @param {string} [params.modelName]
 */
export async function submitKlingImage2VideoTask({
  accessKey,
  prompt,
  firstFrameBase64,
  lastFrameBase64,
  durationSec,
  aspectRatio = "9:16",
  generateAudio = false,
  modelName = resolveKlingVideoModel(),
}) {
  const payload = buildKlingImage2VideoPayload({
    modelName,
    prompt,
    firstFrameBase64,
    lastFrameBase64,
    durationSec,
    aspectRatio,
    generateAudio,
  });

  const response = await fetch(`${KLING_API_BASE}/v1/videos/image2video`, {
    method: "POST",
    headers: authHeaders(accessKey),
    body: JSON.stringify(payload),
  });

  const body = await parseJsonResponse(response);
  const taskId = body.data?.task_id ?? body.data?.taskId;
  if (!taskId) {
    throw new Error(`Kling API: brak task_id w odpowiedzi: ${JSON.stringify(body)}`);
  }
  return taskId;
}

export async function pollKlingImage2VideoTask({
  accessKey,
  taskId,
  pollIntervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
}) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${KLING_API_BASE}/v1/videos/image2video/${taskId}`, {
      headers: authHeaders(accessKey),
    });
    const body = await parseJsonResponse(response);
    const data = body.data ?? {};
    const status = data.task_status ?? data.status;

    if (status === "succeed" || status === "success") {
      const videos = data.task_result?.videos ?? data.task_result ?? [];
      const videoUrl = Array.isArray(videos)
        ? (videos[0]?.url ?? videos[0]?.video_url)
        : videos?.url;
      if (!videoUrl) {
        throw new Error(`Kling task ${taskId} succeeded without video URL`);
      }
      return { taskId, videoUrl, status };
    }

    if (status === "failed" || status === "fail") {
      const reason = data.task_status_msg ?? data.message ?? "unknown";
      throw new Error(`Kling task ${taskId} failed: ${reason}`);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }

  throw new Error(`Kling task ${taskId} timed out after ${timeoutMs}ms`);
}

export async function downloadKlingVideo(videoUrl, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const response = await fetch(videoUrl);
  if (!response.ok) {
    throw new Error(`Kling video download failed: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

/**
 * Full Kling image2video flow: submit → poll → download.
 */
export async function generateKlingHookVideo({
  accessKey,
  prompt,
  firstFrameBase64,
  lastFrameBase64,
  durationSec,
  aspectRatio = "9:16",
  generateAudio = false,
  rawOutputPath,
  modelName = resolveKlingVideoModel(),
}) {
  const taskId = await submitKlingImage2VideoTask({
    accessKey,
    prompt,
    firstFrameBase64,
    lastFrameBase64,
    durationSec,
    aspectRatio,
    generateAudio,
    modelName,
  });

  const { videoUrl } = await pollKlingImage2VideoTask({
    accessKey,
    taskId,
  });

  const tmpPath = rawOutputPath ?? path.join(path.dirname(rawOutputPath ?? "."), `kling_raw_${taskId}.mp4`);
  await downloadKlingVideo(videoUrl, tmpPath);

  return {
    provider: "kling",
    model: modelName,
    taskId,
    videoUrl,
    rawOutputPath: tmpPath,
  };
}
