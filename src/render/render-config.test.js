import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOutputDimensions, DEFAULT_FORMAT_DIMENSIONS } from "./render-config.js";

describe("resolveOutputDimensions", () => {
  it("returns 1920x1080 for 16:9 regardless of recipe override", () => {
    const dims = resolveOutputDimensions("16:9", {
      renderStylePresets: {
        formats: { "16:9": { width: 3840, height: 2160 } },
      },
    });
    assert.deepEqual(dims, DEFAULT_FORMAT_DIMENSIONS["16:9"]);
  });

  it("returns 1080x1920 for 9:16 regardless of recipe override", () => {
    const dims = resolveOutputDimensions("9:16", {
      renderStylePresets: {
        formats: { "9:16": { width: 2160, height: 3840 } },
      },
    });
    assert.deepEqual(dims, DEFAULT_FORMAT_DIMENSIONS["9:16"]);
  });

  it("defaults unknown format to 16:9", () => {
    const dims = resolveOutputDimensions("unknown", {});
    assert.deepEqual(dims, DEFAULT_FORMAT_DIMENSIONS["16:9"]);
  });
});
