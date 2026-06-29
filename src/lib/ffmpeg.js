import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolveFfmpegBins } from "./ffmpeg-bin.js";
import { createLogger, formatDuration, formatVideoDuration } from "./logger.js";

const execFileAsync = promisify(execFile);
const ffmpegLog = createLogger("ffmpeg");

function bins() {
  return resolveFfmpegBins();
}

function parseProgressValue(buffer, key) {
  const match = buffer.match(new RegExp(`(?:^|\\n)${key}=([^\\n]+)`));
  return match?.[1]?.trim() ?? null;
}

export function parseProgressTimeSec(buffer) {
  const outTimeUs = parseProgressValue(buffer, "out_time_us");
  if (outTimeUs && outTimeUs !== "N/A") {
    const sec = Number(outTimeUs) / 1_000_000;
    if (Number.isFinite(sec) && sec >= 0) {
      return sec;
    }
  }

  const outTimeMs = parseProgressValue(buffer, "out_time_ms");
  if (outTimeMs && outTimeMs !== "N/A") {
    const sec = Number(outTimeMs) / 1000;
    if (Number.isFinite(sec) && sec >= 0) {
      return sec;
    }
  }

  const outTime = parseProgressValue(buffer, "out_time");
  if (outTime && outTime !== "N/A") {
    const match = outTime.match(/^(\d+):(\d+):(\d+)\.(\d+)$/);
    if (match) {
      const [, hours, minutes, seconds, micros] = match;
      const sec =
        Number(hours) * 3600 +
        Number(minutes) * 60 +
        Number(seconds) +
        Number(micros) / 1_000_000;
      if (Number.isFinite(sec) && sec >= 0) {
        return sec;
      }
    }
  }

  return null;
}

export function computeFfmpegEta({ currentSec, durationSec, speed }) {
  if (!Number.isFinite(currentSec) || !Number.isFinite(durationSec) || durationSec <= 0) {
    return null;
  }

  const remaining = Math.max(0, durationSec - currentSec);
  const effectiveSpeed = Number.isFinite(speed) && speed > 0.05 ? speed : 1;
  return remaining / effectiveSpeed;
}

export function formatFfmpegProgress({ currentSec, durationSec, etaSec, speed }) {
  if (!Number.isFinite(currentSec) || currentSec < 0) {
    return "przygotowanie…";
  }

  const current = formatVideoDuration(currentSec);
  const total = formatVideoDuration(durationSec);
  const speedLabel = Number.isFinite(speed) && speed > 0 ? `${speed.toFixed(2)}x` : "?x";
  const etaLabel = etaSec == null ? "?" : formatDuration(etaSec * 1000);
  const percent =
    durationSec > 0
      ? Math.min(100, Math.round((currentSec / durationSec) * 100))
      : 0;
  return `${percent}% (${current}/${total}, ${speedLabel}, ETA ~${etaLabel})`;
}

export async function probeDuration(filePath) {
  const { ffprobe } = bins();
  const { stdout } = await execFileAsync(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);

  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Nie udało się odczytać długości pliku: ${filePath}`);
  }

  return duration;
}

export async function probeVideoDimensions(filePath) {
  const { ffprobe } = bins();
  const { stdout } = await execFileAsync(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    filePath,
  ]);

  const [width, height] = stdout.trim().split(",").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`Nie udało się odczytać wymiarów wideo: ${filePath}`);
  }

  return { width, height };
}

export async function probeAudioStream(filePath) {
  const { ffprobe } = bins();
  const { stdout } = await execFileAsync(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name",
    "-select_streams",
    "a",
    "-of",
    "json",
    filePath,
  ]);

  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.find((s) => s.codec_type === "audio");
  if (!stream) {
    throw new Error(`Brak strumienia audio: ${filePath}`);
  }

  return {
    codecType: stream.codec_type,
    codecName: stream.codec_name,
  };
}

export async function probeCreationTime(filePath) {
  const { ffprobe } = bins();
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format_tags=creation_time",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const value = stdout.trim();
    if (value) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  } catch {
    // fallback to mtime handled by caller
  }
  return null;
}

export async function extractFrameAt(videoPath, timestampSec, outputPath) {
  await runFfmpeg(
    [
      "-y",
      "-ss",
      String(timestampSec),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath,
    ],
    { label: `frame @ ${timestampSec.toFixed(1)}s` },
  );
}

export async function runFfmpeg(
  args,
  { label = "ffmpeg", heartbeatSec = 20, cwd, durationSec, onProgress } = {},
) {
  const progressEnabled = Number.isFinite(durationSec) && durationSec > 0;

  return ffmpegLog.track(
    label,
    () =>
      new Promise((resolve, reject) => {
        const { ffmpeg } = bins();
        const ffmpegArgs = [
          "-hide_banner",
          "-loglevel",
          "error",
          ...(progressEnabled ? ["-progress", "pipe:2"] : []),
          ...args,
        ];
        const child = spawn(ffmpeg, ffmpegArgs, {
          stdio: ["ignore", "ignore", "pipe"],
          cwd,
        });

        let stderr = "";
        let progressBuffer = "";
        let lastProgressLogAt = Date.now();

        child.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          stderr += text;

          if (!progressEnabled) {
            return;
          }

          progressBuffer += text;
          if (progressBuffer.length > 32_000) {
            progressBuffer = progressBuffer.slice(-16_000);
          }

          const currentSec = parseProgressTimeSec(progressBuffer);
          if (currentSec == null || currentSec < 0.25) {
            return;
          }

          const speedRaw = parseProgressValue(progressBuffer, "speed");
          const speed = speedRaw === "N/A" ? null : Number.parseFloat(speedRaw);
          const etaSec = computeFfmpegEta({ currentSec, durationSec, speed });
          const payload = { currentSec, durationSec, speed, etaSec };

          if (onProgress) {
            onProgress(payload);
          }

          const now = Date.now();
          if (now - lastProgressLogAt >= 15_000) {
            lastProgressLogAt = now;
            ffmpegLog.detail(`… ${label} — ${formatFfmpegProgress(payload)}`);
          }
        });

        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(new Error(stderr.trim() || `${label} zakończone kodem ${code}`));
        });
      }),
    { heartbeatSec: progressEnabled ? 0 : heartbeatSec },
  );
}
