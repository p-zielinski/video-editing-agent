import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
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

  it("classifies DPDFNet AudioEnhancementProviderError", () => {
    const error = new AudioEnhancementProviderError("dpdfnet missing", {
      code: ERROR_CODES.AUDIO_ENH_DPDFNET_FAILED,
      provider: "dpdfnet",
      clipId: "clip17",
      stderr: "command not found",
    });
    const classified = classifyError(error, { step: "audio_enhancement" });
    assert.equal(classified.code, ERROR_CODES.AUDIO_ENH_DPDFNET_FAILED);
    assert.equal(classified.scope?.clipId, "clip17");
  });

  it("classifies RECIPE_VALIDATION_FAILED", () => {
    const error = new Error("validation failed");
    error.code = "RECIPE_VALIDATION_FAILED";
    const classified = classifyError(error);
    assert.equal(classified.code, ERROR_CODES.RECIPE_VALIDATION_FAILED);
    assert.equal(classified.step, "review");
  });

  it("classifies ZodError with LLM cache hints", () => {
    const error = z.object({ ok: z.boolean() }).safeParse({ ok: "nope" }).error;
    error.llmRejectionPath = "/tmp/rejected.json";
    error.llmCacheHint = "wznów z --reuse-llm-cache";
    const classified = classifyError(error, { step: "direct" });
    assert.equal(classified.step, "direct");
    assert.ok(classified.prerequisites?.includes("wznów z --reuse-llm-cache"));
    assert.ok(classified.prerequisites?.some((entry) => entry.includes("/tmp/rejected.json")));
  });
});
