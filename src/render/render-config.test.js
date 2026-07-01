import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRenderProfile, RENDER_PROFILES, buildExecuteRenderOptions } from "./render-config.js";

describe("render-config profiles", () => {
  it("resolveRenderProfile returns preview bundle", () => {
    const profile = resolveRenderProfile("preview");
    assert.equal(profile.encodeProfile, "draft");
    assert.equal(profile.skipCreative, true);
    assert.equal(profile.skipSubtitles, true);
  });

  it("resolveRenderProfile returns empty for unknown name", () => {
    assert.deepEqual(resolveRenderProfile("unknown_xyz"), {});
  });

  it("buildExecuteRenderOptions merges profile with explicit CLI flags", () => {
    const options = buildExecuteRenderOptions({
      renderProfile: "preview",
      skipCreative: false,
      outputId: "horizontal_main",
    });
    assert.equal(options.encodeProfile, "draft");
    assert.equal(options.skipCreative, false);
    assert.equal(options.skipSubtitles, true);
    assert.equal(options.outputId, "horizontal_main");
  });

  it("RENDER_PROFILES includes iterate with keepTmp", () => {
    assert.equal(RENDER_PROFILES.iterate.keepTmp, true);
  });
});
