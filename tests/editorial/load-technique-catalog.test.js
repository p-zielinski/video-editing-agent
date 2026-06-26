import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";

describe("loadTechniqueCatalog", () => {
  it("loads default pack with techniques", () => {
    const catalog = loadTechniqueCatalog();
    assert.ok(catalog.techniques.length >= 15);
    assert.equal(catalog.packId, "youtube_vlog_2026");
    assert.ok(catalog.byId.has("zoom_punch_in"));
    assert.ok(catalog.byId.has("cut_mid_sentence"));
  });

  it("filters by shorts_energy pack", () => {
    const catalog = loadTechniqueCatalog({ pack: "shorts_energy" });
    assert.equal(catalog.packId, "shorts_energy");
    assert.ok(catalog.byId.has("snap_zoom"));
    assert.ok(!catalog.byId.has("zoom_slow_push"));
  });

  it("falls back to default pack for unknown pack", () => {
    const catalog = loadTechniqueCatalog({ pack: "nonexistent_pack_xyz" });
    assert.equal(catalog.packId, "youtube_vlog_2026");
    assert.ok(catalog.techniques.length > 0);
  });

  it("filters by platform", () => {
    const catalog = loadTechniqueCatalog({ platforms: ["shorts"] });
    for (const t of catalog.techniques) {
      assert.ok(t.platforms.includes("shorts"));
    }
  });

  it("exposes defaultCreativityLevel from pack", () => {
    const catalog = loadTechniqueCatalog({ pack: "shorts_energy" });
    assert.equal(catalog.pack.defaultCreativityLevel, "shorts");
  });
});
