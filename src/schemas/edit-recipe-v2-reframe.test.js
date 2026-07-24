import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VideoTransformSchema } from "./edit-recipe-v2.js";

const baseTransform = {
  speed: 1,
  speedMode: "video_audio",
};

describe("ReframeModeSchema", () => {
  it("coerces center_crop to center", () => {
    const parsed = VideoTransformSchema.parse({
      ...baseTransform,
      reframe: "center_crop",
    });
    assert.equal(parsed.reframe, "center");
  });

  it("coerces follow_subject to subject", () => {
    const parsed = VideoTransformSchema.parse({
      ...baseTransform,
      reframe: "follow_subject",
    });
    assert.equal(parsed.reframe, "subject");
  });

  it("coerces reframe_follow_subject to subject", () => {
    const parsed = VideoTransformSchema.parse({
      ...baseTransform,
      reframe: "reframe_follow_subject",
    });
    assert.equal(parsed.reframe, "subject");
  });

  it("preserves valid reframe values", () => {
    const parsed = VideoTransformSchema.parse({
      ...baseTransform,
      reframe: "face",
    });
    assert.equal(parsed.reframe, "face");
  });

  it("strips unknown reframe values", () => {
    const parsed = VideoTransformSchema.parse({
      ...baseTransform,
      reframe: "foobar",
    });
    assert.equal(parsed.reframe, undefined);
  });
});
