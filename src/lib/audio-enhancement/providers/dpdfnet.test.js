import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AudioEnhancementProviderError } from "../../recovery/errors.js";
import { ERROR_CODES } from "../../recovery/error-codes.js";
import { enhanceWithDpdfnet } from "./dpdfnet.js";

describe("dpdfnet provider", () => {
  it("throws AudioEnhancementProviderError when dpdfnet binary is missing", async () => {
    await assert.rejects(
      () => enhanceWithDpdfnet({
        inputPath: "/tmp/in.wav",
        outputPath: "/tmp/out.wav",
        dpdfnetBin: "__definitely_missing_dpdfnet_binary__",
        dpdfnetModel: "dpdfnet8_48khz_hr",
        dpdfnetAttnLimitDb: 12,
      }),
      (error) => {
        assert.ok(error instanceof AudioEnhancementProviderError);
        assert.equal(error.code, ERROR_CODES.AUDIO_ENH_DPDFNET_FAILED);
        return true;
      },
    );
  });
});
