import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AudioEnhancementProviderError } from "../../recovery/errors.js";
import { ERROR_CODES } from "../../recovery/error-codes.js";

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
    child.on("error", (spawnError) => {
      reject(new AudioEnhancementProviderError(
        `Nie udało się uruchomić DeepFilterNet (${deepFilterBin}): ${spawnError.message}`,
        {
          code: ERROR_CODES.AUDIO_ENH_DEEPFILTERNET_FAILED,
          provider: "deepfilternet",
          stderr: spawnError.message,
          recoveryHint: "Zainstaluj deepFilter i ustaw DEEPFILTERNET_BIN",
        },
      ));
    });
    child.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(outputPath)) {
        reject(new AudioEnhancementProviderError(
          stderr.trim() || `deepFilter failed (code ${code})`,
          {
            code: ERROR_CODES.AUDIO_ENH_DEEPFILTERNET_FAILED,
            provider: "deepfilternet",
            stderr: stderr.trim() || null,
            exitCode: code,
            recoveryHint: "Sprawdź instalację DeepFilterNet lub ustaw AUDIO_ENHANCEMENT_PROVIDER=ffmpeg dla jawnego fallbacku",
          },
        ));
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
  clipId = null,
}) {
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
    ...(clipId ? { clipId } : {}),
  };
}
