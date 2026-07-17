import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { enhanceWithFfmpegDenoise } from "./ffmpeg-denoise.js";

async function runDeepFilter({ inputPath, outputPath, deepFilterBin, deepFilterModelPath }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = [inputPath, outputPath];
  if (deepFilterModelPath) {
    args.push("-m", deepFilterModelPath);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(deepFilterBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(outputPath)) {
        reject(new Error(stderr.trim() || `deepFilter failed (code ${code})`));
        return;
      }
      resolve();
    });
  });
}

export async function enhanceWithDeepFilterNet({
  inputPath,
  outputPath,
  deepFilterBin,
  deepFilterModelPath,
  arnndnModelPath,
}) {
  try {
    await runDeepFilter({
      inputPath,
      outputPath,
      deepFilterBin,
      deepFilterModelPath,
    });
    return {
      provider: "deepfilternet",
      model: deepFilterModelPath ?? "default",
      status: "succeeded",
    };
  } catch {
    return enhanceWithFfmpegDenoise({
      inputPath,
      outputPath,
      arnndnModelPath,
    });
  }
}
