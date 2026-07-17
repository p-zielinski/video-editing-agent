import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampGainDb, resolveTargetDialogueLufs } from "./normalize.js";

describe("audio-enhancement normalize", () => {
  it("clampGainDb limits gain range", () => {
    assert.equal(clampGainDb(20), 12);
    assert.equal(clampGainDb(-20), -12);
    assert.equal(clampGainDb(3), 3);
  });

  it("resolveTargetDialogueLufs prefers decision target", () => {
    assert.equal(resolveTargetDialogueLufs({ targetDialogueLufs: -20 }), -20);
    assert.equal(resolveTargetDialogueLufs({}, [-19, -17, -16]), -17);
    assert.equal(resolveTargetDialogueLufs({}), -18);
  });
});
