import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClipRegistryEntrySchema } from "./edit-recipe-v2.js";

describe("RoleSourceSchema", () => {
  it("accepts ai_video roleSource for AI hook clips", () => {
    const parsed = ClipRegistryEntrySchema.parse({
      clipId: "ai_hook_01",
      fileName: "ai_hook_01.mp4",
      durationSec: 5,
      sortIndex: 40,
      clipRole: "ai_generated",
      roleConfidence: 1,
      roleSource: "ai_video",
      hasSpeech: false,
      speechWordCount: 0,
      visualSummary: "AI-generated short hook",
      mediaType: "video",
    });

    assert.equal(parsed.roleSource, "ai_video");
  });
});
