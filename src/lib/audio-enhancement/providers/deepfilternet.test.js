import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AudioEnhancementProviderError } from "../../recovery/errors.js";
import { ERROR_CODES } from "../../recovery/error-codes.js";
import { enhanceWithDeepFilterNet } from "./deepfilternet.js";

describe("deepfilternet provider", () => {
  it("throws AudioEnhancementProviderError when deepFilter binary is missing", async () => {
    await assert.rejects(
      () => enhanceWithDeepFilterNet({
        inputPath: "/tmp/in.wav",
        outputPath: "/tmp/out.wav",
        deepFilterBin: "__definitely_missing_deepfilter_binary__",
      }),
      (error) => {
        assert.ok(error instanceof AudioEnhancementProviderError);
        assert.equal(error.code, ERROR_CODES.AUDIO_ENH_DEEPFILTERNET_FAILED);
        return true;
      },
    );
  });
});
