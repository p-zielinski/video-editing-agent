import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyError } from "./classify-error.js";
import { ERROR_CODES } from "./error-codes.js";
import { AudioEnhancementProviderError } from "./errors.js";

describe("recovery classify-error", () => {
  it("classifies AudioEnhancementProviderError", () => {
    const error = new AudioEnhancementProviderError("deepFilter missing", {
      code: ERROR_CODES.AUDIO_ENH_DEEPFILTERNET_FAILED,
      provider: "deepfilternet",
      clipId: "clip16",
      stderr: "command not found",
    });
    const classified = classifyError(error, { step: "audio_enhancement" });
    assert.equal(classified.code, ERROR_CODES.AUDIO_ENH_DEEPFILTERNET_FAILED);
    assert.equal(classified.scope?.clipId, "clip16");
  });

  it("classifies RECIPE_VALIDATION_FAILED", () => {
    const error = new Error("validation failed");
    error.code = "RECIPE_VALIDATION_FAILED";
    const classified = classifyError(error);
    assert.equal(classified.code, ERROR_CODES.RECIPE_VALIDATION_FAILED);
    assert.equal(classified.step, "review");
  });
});
