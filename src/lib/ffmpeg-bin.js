import fs from "node:fs";
import path from "node:path";

const FFMPEG_FULL_CANDIDATES = [
  "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
  "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
];

let cached = null;

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveFfmpegBins() {
  if (cached) {
    return cached;
  }

  if (process.env.FFMPEG_PATH) {
    const ffmpeg = process.env.FFMPEG_PATH;
    const ffprobe =
      process.env.FFPROBE_PATH ?? path.join(path.dirname(ffmpeg), "ffprobe");
    cached = { ffmpeg, ffprobe };
    return cached;
  }

  const ffmpegFull = FFMPEG_FULL_CANDIDATES.find(isExecutable);
  if (ffmpegFull) {
    cached = {
      ffmpeg: ffmpegFull,
      ffprobe: path.join(path.dirname(ffmpegFull), "ffprobe"),
    };
    return cached;
  }

  cached = {
    ffmpeg: "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH ?? "ffprobe",
  };
  return cached;
}
