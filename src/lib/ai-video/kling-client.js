import fs from "node:fs";
import path from "node:path";
import { createKlingJwt } from "./kling-auth.js";
import { KLING_API_BASE } from "./types.js";

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 180_000;

function resolveModelName() {
  return process.env.KLING_VIDEO_MODEL ?? "kling-v2-6";
}

function resolveDurationString(durationSec) {
  const rounded = Math.max(3, Math.min(15, Math.round(durationSec)));
  if (rounded <= 5) {
    return "5";
  }
  if (rounded <= 10) {
    return "10";
  }
  return "10";
}

function authHeaders(accessKey, secretKey) {
  return {
    Authorization: `Bearer ${createKlingJwt(accessKey, secretKey)}`,
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
 * @param {string} params.secretKey
 * @param {string} params.prompt
 * @param {string} params.firstFrameBase64
 * @param {string} params.lastFrameBase64
 * @param {number} params.durationSec
 * @param {string} [params.aspectRatio]
 * @param {boolean} [params.generateAudio]
 */
export async function submitKlingImage2VideoTask({
  accessKey,
  secretKey,
  prompt,
  firstFrameBase64,
  lastFrameBase64,
  durationSec,
  aspectRatio = "9:16",
  generateAudio = false,
}) {
  const payload = {
    model_name: resolveModelName(),
    prompt,
    image: firstFrameBase64,
    image_tail: lastFrameBase64,
    mode: "pro",
    aspect_ratio: aspectRatio,
    duration: resolveDurationString(durationSec),
    sound: generateAudio ? "on" : "off",
  };

  const response = await fetch(`${KLING_API_BASE}/v1/videos/image2video`, {
    method: "POST",
    headers: authHeaders(accessKey, secretKey),
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
  secretKey,
  taskId,
  pollIntervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
}) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${KLING_API_BASE}/v1/videos/image2video/${taskId}`, {
      headers: authHeaders(accessKey, secretKey),
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
  secretKey,
  prompt,
  firstFrameBase64,
  lastFrameBase64,
  durationSec,
  aspectRatio = "9:16",
  generateAudio = false,
  rawOutputPath,
}) {
  const taskId = await submitKlingImage2VideoTask({
    accessKey,
    secretKey,
    prompt,
    firstFrameBase64,
    lastFrameBase64,
    durationSec,
    aspectRatio,
    generateAudio,
  });

  const { videoUrl } = await pollKlingImage2VideoTask({
    accessKey,
    secretKey,
    taskId,
  });

  const tmpPath = rawOutputPath ?? path.join(path.dirname(rawOutputPath ?? "."), `kling_raw_${taskId}.mp4`);
  await downloadKlingVideo(videoUrl, tmpPath);

  return {
    provider: "kling",
    taskId,
    videoUrl,
    rawOutputPath: tmpPath,
  };
}
