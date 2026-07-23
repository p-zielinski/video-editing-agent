import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isThinTwelveLabsInsights, countTwelveLabsInsightItems } from "./twelvelabs-client.js";

describe("twelvelabs thin insights", () => {
  it("detects indexed payloads with empty chapters/moments and no summary", () => {
    assert.equal(isThinTwelveLabsInsights({
      indexingStatus: "indexed",
      chapters: [],
      moments: [],
    }), true);
  });

  it("does not flag frame analysis or recovered fallbacks", () => {
    assert.equal(isThinTwelveLabsInsights({
      indexingStatus: "frame_analysis",
      chapters: [],
      moments: [],
    }), false);
    assert.equal(isThinTwelveLabsInsights({
      indexingStatus: "frame_analysis_fallback",
      chapters: [{ startSec: 0, endSec: 2 }],
      moments: [],
    }), false);
  });

  it("counts insight items", () => {
    assert.equal(countTwelveLabsInsightItems({
      chapters: [{}, {}],
      moments: [{}],
    }), 3);
  });
});
