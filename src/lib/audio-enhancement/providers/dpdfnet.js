import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AudioEnhancementProviderError } from "../../recovery/errors.js";
import { ERROR_CODES } from "../../recovery/error-codes.js";

async function runDpdfnet({
  inputPath,
  outputPath,
  dpdfnetBin,
  dpdfnetModel,
  dpdfnetAttnLimitDb,
}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = [
    "enhance",
    inputPath,
    outputPath,
    "--model",
    dpdfnetModel,
  ];
  if (dpdfnetAttnLimitDb != null) {
    args.push("--attn-limit-db", String(dpdfnetAttnLimitDb));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(dpdfnetBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (spawnError) => {
      reject(new AudioEnhancementProviderError(
        `Nie udało się uruchomić DPDFNet (${dpdfnetBin}): ${spawnError.message}`,
        {
          code: ERROR_CODES.AUDIO_ENH_DPDFNET_FAILED,
          provider: "dpdfnet",
          stderr: spawnError.message,
          recoveryHint: "Zainstaluj dpdfnet (pip install dpdfnet) i ustaw DPDFNET_BIN",
        },
      ));
    });
    child.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(outputPath)) {
        reject(new AudioEnhancementProviderError(
          stderr.trim() || `dpdfnet failed (code ${code})`,
          {
            code: ERROR_CODES.AUDIO_ENH_DPDFNET_FAILED,
            provider: "dpdfnet",
            stderr: stderr.trim() || null,
            exitCode: code,
            recoveryHint: "Sprawdź instalację DPDFNet (dpdfnet download) lub ustaw AUDIO_ENHANCEMENT_PROVIDER=ffmpeg dla jawnego fallbacku",
          },
        ));
        return;
      }
      resolve();
    });
  });
}

export async function enhanceWithDpdfnet({
  inputPath,
  outputPath,
  dpdfnetBin,
  dpdfnetModel,
  dpdfnetAttnLimitDb,
  clipId = null,
}) {
  await runDpdfnet({
    inputPath,
    outputPath,
    dpdfnetBin,
    dpdfnetModel,
    dpdfnetAttnLimitDb,
  });
  return {
    provider: "dpdfnet",
    model: dpdfnetModel,
    status: "succeeded",
    ...(clipId ? { clipId } : {}),
  };
}
