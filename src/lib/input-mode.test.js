import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectInputMode, resolveDefaultSortBy } from "./input-mode.js";

describe("input-mode", () => {
  it("detectInputMode returns multi_clip_day for multiple clips", () => {
    assert.equal(detectInputMode(2), "multi_clip_day");
    assert.equal(detectInputMode(1), "single_clip");
  });

  it("resolveDefaultSortBy prefers creation_time for multi-clip", () => {
    assert.equal(resolveDefaultSortBy(2), "creation_time");
    assert.equal(resolveDefaultSortBy(1), "mtime");
    assert.equal(resolveDefaultSortBy(1, { inputMode: "multi_clip_day" }), "creation_time");
  });

  it("resolveDefaultSortBy respects batchContext.sortBy override", () => {
    assert.equal(resolveDefaultSortBy(5, { sortBy: "name" }), "name");
  });
});
