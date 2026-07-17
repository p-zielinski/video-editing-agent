import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveVoiceResynthesisConfig,
  validateResynthesisMoment,
} from "./index.js";

describe("voice-resynthesis", () => {
  it("validateResynthesisMoment requires consent and human review", () => {
    const config = resolveVoiceResynthesisConfig({
      VOICE_RESYNTHESIS_REQUIRE_CONSENT: "1",
    });
    const issues = validateResynthesisMoment({
      startSec: 1,
      endSec: 3,
      consentRequired: false,
      needsHumanReview: false,
    }, config);
    assert.ok(issues.includes("consent_required"));
    assert.ok(issues.includes("human_review_required"));
  });

  it("validateResynthesisMoment rejects long chunks", () => {
    const config = resolveVoiceResynthesisConfig({
      VOICE_RESYNTHESIS_MAX_CHUNK_SEC: "10",
    });
    const issues = validateResynthesisMoment({
      startSec: 0,
      endSec: 20,
      consentRequired: true,
      needsHumanReview: true,
    }, config);
    assert.ok(issues.includes("chunk_too_long"));
  });
});
