import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROFILES,
  resolveAnalysisProfile,
  listEnabledAnalysisStubs,
} from "./analysis-profiles.js";

describe("analysis-profiles", () => {
  it("preview enables all analysis stubs", () => {
    const resolved = resolveAnalysisProfile("preview", {});
    assert.equal(resolved.visionStub, true);
    assert.equal(resolved.faceStub, true);
    assert.equal(resolved.audioStub, true);
    assert.equal(resolved.objectsStub, true);
    assert.equal(resolved.twelvelabsStub, true);
    assert.equal(resolved.globalCacheDisabled, false);
  });

  it("production disables stubs", () => {
    const resolved = resolveAnalysisProfile("production", {});
    assert.equal(resolved.visionStub, false);
    assert.equal(resolved.twelvelabsStub, false);
  });

  it("ci matches preview and disables global cache", () => {
    const resolved = resolveAnalysisProfile("ci", {});
    assert.equal(resolved.visionStub, true);
    assert.equal(resolved.globalCacheDisabled, true);
    assert.deepEqual(PROFILES.ci.globalCacheDisabled, true);
  });

  it("explicit flags override profile defaults", () => {
    const resolved = resolveAnalysisProfile("preview", { visionStub: false });
    assert.equal(resolved.visionStub, false);
    assert.equal(resolved.faceStub, true);
  });

  it("rejects unknown profile names", () => {
    assert.throws(
      () => resolveAnalysisProfile("unknown", {}),
      /Nieznany profil analizy/,
    );
  });

  it("listEnabledAnalysisStubs returns active stub labels", () => {
    const labels = listEnabledAnalysisStubs(resolveAnalysisProfile("preview", {}));
    assert.deepEqual(labels, ["vision", "face", "audio", "objects", "twelvelabs"]);
  });
});
