import { enhanceWithStub } from "./stub.js";
import { enhanceWithDeepFilterNet } from "./deepfilternet.js";
import { enhanceWithFfmpegDenoise } from "./ffmpeg-denoise.js";

export async function runEnhancementProvider({
  inputPath,
  outputPath,
  config,
  providerPreference = "auto",
  clipId = null,
}) {
  if (config.stub) {
    return enhanceWithStub({ inputPath, outputPath });
  }

  const provider = providerPreference === "paid" && config.paidProvider
    ? config.paidProvider
    : config.provider;

  if (provider === "stub") {
    return enhanceWithStub({ inputPath, outputPath });
  }

  if (provider === "ffmpeg" || provider === "afftdn" || provider === "arnndn") {
    return enhanceWithFfmpegDenoise({
      inputPath,
      outputPath,
      arnndnModelPath: config.arnndnModelPath,
    });
  }

  if (providerPreference === "paid" && config.paidProvider) {
    throw new Error(`Paid audio enhancement provider not configured: ${config.paidProvider}`);
  }

  return enhanceWithDeepFilterNet({
    inputPath,
    outputPath,
    deepFilterBin: config.deepFilterBin,
    deepFilterModelPath: config.deepFilterModelPath,
    clipId,
  });
}
