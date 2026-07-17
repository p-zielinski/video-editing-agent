export function resolveAudioEnhancementConfig() {
  const stub = process.env.AUDIO_ENHANCEMENT_STUB === "1"
    || process.env.AUDIO_ENHANCEMENT_STUB === "true";
  const required = process.env.AUDIO_ENHANCEMENT_REQUIRED === "1"
    || process.env.AUDIO_ENHANCEMENT_REQUIRED === "true";

  return {
    provider: process.env.AUDIO_ENHANCEMENT_PROVIDER ?? "deepfilternet",
    stub,
    required,
    maxConcurrency: Number.parseInt(process.env.AUDIO_ENHANCEMENT_MAX_CONCURRENCY ?? "1", 10) || 1,
    deepFilterBin: process.env.DEEPFILTERNET_BIN ?? "deepFilter",
    deepFilterModelPath: process.env.DEEPFILTERNET_MODEL_PATH ?? null,
    arnndnModelPath: process.env.ARNNDN_MODEL_PATH ?? null,
    paidProvider: process.env.AUDIO_ENHANCEMENT_PAID_PROVIDER ?? null,
    paidApiKey: process.env.AUDIO_ENHANCEMENT_API_KEY ?? null,
    paidApiBaseUrl: process.env.AUDIO_ENHANCEMENT_API_BASE_URL ?? null,
    allowUpload: process.env.AUDIO_ENHANCEMENT_ALLOW_UPLOAD === "1"
      || process.env.AUDIO_ENHANCEMENT_ALLOW_UPLOAD === "true",
  };
}
