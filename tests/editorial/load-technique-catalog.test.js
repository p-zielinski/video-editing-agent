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

  it("applies vlog pack constraintOverrides for silence_beat at balanced", () => {
    const catalog = loadTechniqueCatalog({ pack: "youtube_vlog_2026" });
    const silenceBeat = catalog.byId.get("silence_beat");
    assert.equal(silenceBeat.constraints.requiresCreativityLevel, "balanced");
  });

  it("exposes silence_beat volumeFactor param with default 0.3", () => {
    const catalog = loadTechniqueCatalog();
    const silenceBeat = catalog.byId.get("silence_beat");
    assert.ok(silenceBeat);
    assert.equal(silenceBeat.params.volumeFactor.default, 0.3);
    assert.equal(silenceBeat.params.volumeFactor.min, 0);
    assert.equal(silenceBeat.params.volumeFactor.max, 1);
  });

  it("does not lower silence_beat gate on non-vlog packs", () => {
    const catalog = loadTechniqueCatalog({ pack: "shorts_energy" });
    const silenceBeat = catalog.byId.get("silence_beat");
    assert.equal(silenceBeat, undefined);
  });

  it("loads voice_pitch_shift from catalog and shorts_retention pack override", () => {
    const catalog = loadTechniqueCatalog();
    const pitch = catalog.byId.get("voice_pitch_shift");
    assert.ok(pitch);
    assert.equal(pitch.params.semitones.min, -8);
    assert.equal(pitch.params.semitones.max, 8);

    const shorts = loadTechniqueCatalog({ pack: "shorts_retention_2026" });
    const shortsPitch = shorts.byId.get("voice_pitch_shift");
    assert.ok(shortsPitch);
    assert.equal(shortsPitch.constraints.requiresCreativityLevel, "shorts");
  });

  it("chapter_card requires short creativeMoment; documents main textOverlays delivery", () => {
    const catalog = loadTechniqueCatalog({ pack: "shorts_retention_2026" });
    const chapterCard = catalog.byId.get("chapter_card");
    assert.ok(chapterCard);
    assert.equal(chapterCard.constraints.requiresOutputKind, "short");
    assert.match(chapterCard.whenToUse, /textOverlays/i);
    assert.match(chapterCard.whenToAvoid, /main/i);
  });

  it("loads color techniques with schema params and renderSupport full", () => {
    const catalog = loadTechniqueCatalog();
    const desaturate = catalog.byId.get("color_desaturate");
    const boost = catalog.byId.get("color_saturation_boost");
    assert.ok(desaturate);
    assert.ok(boost);
    assert.equal(desaturate.category, "color");
    assert.equal(desaturate.params.amount.default, 1);
    assert.equal(desaturate.params.amount.min, 0);
    assert.equal(desaturate.params.amount.max, 1);
    assert.equal(boost.params.boost.default, 0.12);
    assert.equal(boost.params.boost.min, 0.05);
    assert.equal(boost.params.boost.max, 0.25);
    assert.equal(desaturate.renderSupport, "full");
    assert.equal(boost.renderSupport, "full");
  });

  it("includes color techniques in youtube_vlog_2026 and shorts packs", () => {
    const vlog = loadTechniqueCatalog({ pack: "youtube_vlog_2026" });
    assert.ok(vlog.byId.has("color_desaturate"));
    assert.ok(vlog.byId.has("color_saturation_boost"));
    assert.equal(vlog.byId.get("color_desaturate").constraints.requiresCreativityLevel, "balanced");

    const retention = loadTechniqueCatalog({ pack: "shorts_retention_2026" });
    assert.ok(retention.byId.has("color_desaturate"));
    assert.ok(retention.byId.has("color_saturation_boost"));

    const energy = loadTechniqueCatalog({ pack: "shorts_energy" });
    assert.ok(energy.byId.has("color_desaturate"));
    assert.ok(energy.byId.has("color_saturation_boost"));
  });
});
