import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_KLING_VIDEO_MODEL,
  buildKlingImage2VideoPayload,
  resolveKlingDurationString,
  resolveKlingVideoModel,
} from "./kling-client.js";

describe("Kling video client configuration", () => {
  it("defaults to the prompt-led Kling VIDEO 3 model", () => {
    assert.equal(DEFAULT_KLING_VIDEO_MODEL, "kling-v3");
    assert.equal(resolveKlingVideoModel({}), "kling-v3");
    assert.equal(
      resolveKlingVideoModel({ KLING_VIDEO_MODEL: "custom-kling" }),
      "custom-kling",
    );
  });

  it("uses flexible 3-15 second durations for Kling v3", () => {
    assert.equal(resolveKlingDurationString(3, "kling-v3"), "3");
    assert.equal(resolveKlingDurationString(7.6, "kling-v3"), "8");
    assert.equal(resolveKlingDurationString(15, "kling-v3"), "15");
    assert.equal(resolveKlingDurationString(20, "kling-v3"), "15");
  });

  it("preserves legacy 5/10 second duration buckets for older models", () => {
    assert.equal(resolveKlingDurationString(3, "kling-v2-6"), "5");
    assert.equal(resolveKlingDurationString(8, "kling-v2-6"), "10");
    assert.equal(resolveKlingDurationString(15, "kling-v2-6"), "10");
  });

  it("builds a v3 start/end-frame image-to-video payload", () => {
    assert.deepEqual(buildKlingImage2VideoPayload({
      modelName: "kling-v3",
      prompt: "Cinematic transition",
      firstFrameBase64: "first",
      lastFrameBase64: "last",
      durationSec: 7,
      aspectRatio: "9:16",
      generateAudio: false,
    }), {
      model_name: "kling-v3",
      prompt: "Cinematic transition",
      image: "first",
      image_tail: "last",
      mode: "pro",
      aspect_ratio: "9:16",
      duration: "7",
      sound: "off",
    });
  });
});
