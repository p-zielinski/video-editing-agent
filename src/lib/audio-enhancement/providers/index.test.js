import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AudioEnhancementProviderError } from "../../recovery/errors.js";
import { ERROR_CODES } from "../../recovery/error-codes.js";
import { runEnhancementProvider } from "./index.js";

const baseConfig = {
  stub: false,
  paidProvider: null,
  arnndnModelPath: null,
  deepFilterBin: "__definitely_missing_deepfilter_binary__",
  deepFilterModelPath: null,
  dpdfnetBin: "__definitely_missing_dpdfnet_binary__",
  dpdfnetModel: "dpdfnet8_48khz_hr",
  dpdfnetAttnLimitDb: 12,
};

describe("audio enhancement provider router", () => {
  it("routes dpdfnet provider to DPDFNet CLI", async () => {
    await assert.rejects(
      () => runEnhancementProvider({
        inputPath: "/tmp/in.wav",
        outputPath: "/tmp/out.wav",
        config: { ...baseConfig, provider: "dpdfnet" },
      }),
      (error) => {
        assert.ok(error instanceof AudioEnhancementProviderError);
        assert.equal(error.code, ERROR_CODES.AUDIO_ENH_DPDFNET_FAILED);
        return true;
      },
    );
  });

  it("routes deepfilternet provider to DeepFilterNet CLI", async () => {
    await assert.rejects(
      () => runEnhancementProvider({
        inputPath: "/tmp/in.wav",
        outputPath: "/tmp/out.wav",
        config: { ...baseConfig, provider: "deepfilternet" },
      }),
      (error) => {
        assert.ok(error instanceof AudioEnhancementProviderError);
        assert.equal(error.code, ERROR_CODES.AUDIO_ENH_DEEPFILTERNET_FAILED);
        return true;
      },
    );
  });

  it("throws on unknown provider", async () => {
    await assert.rejects(
      () => runEnhancementProvider({
        inputPath: "/tmp/in.wav",
        outputPath: "/tmp/out.wav",
        config: { ...baseConfig, provider: "unknown_provider" },
      }),
      /Unknown audio enhancement provider: unknown_provider/,
    );
  });
});
