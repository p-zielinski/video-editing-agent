import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCatalogForPrompt } from "../../src/editorial/format-catalog-for-prompt.js";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";
import { computeCreativityBudget } from "../../src/editorial/technique-budget.js";

describe("formatCatalogForPrompt", () => {
  it("returns compact table for LLM", () => {
    const catalog = loadTechniqueCatalog();
    const budget = computeCreativityBudget(600, { level: "balanced" });
    const formatted = formatCatalogForPrompt(catalog, budget);

    assert.equal(formatted.packId, "youtube_vlog_2026");
    assert.ok(formatted.techniques.length > 0);
    assert.ok(formatted.techniques[0].id);
    assert.ok(formatted.techniques[0].whenToUse);
    assert.equal(formatted.budget.maxZoomMoments, budget.maxZoomMoments);
  });

  it("includes param min/max/default in table", () => {
    const catalog = loadTechniqueCatalog();
    const budget = computeCreativityBudget(600, { level: "balanced" });
    const formatted = formatCatalogForPrompt(catalog, budget);
    const zoom = formatted.techniques.find((t) => t.id === "zoom_punch_in");
    assert.ok(zoom?.params);
    assert.match(zoom.params, /factor/);
    assert.match(zoom.params, /def=/);
  });

  it("filters techniques for safe level", () => {
    const catalog = loadTechniqueCatalog();
    const safeBudget = computeCreativityBudget(600, { level: "safe" });
    const formatted = formatCatalogForPrompt(catalog, safeBudget);
    const ids = formatted.techniques.map((t) => t.id);
    assert.ok(ids.includes("cut_on_beat"));
    assert.ok(ids.includes("crossfade"));
    assert.ok(!ids.includes("jump_cut"));
    assert.ok(formatted.techniqueCount < catalog.techniques.length);
  });

  it("includes renderSupport for stub and partial techniques only", () => {
    const catalog = loadTechniqueCatalog();
    const budget = computeCreativityBudget(600, { level: "balanced" });
    const formatted = formatCatalogForPrompt(catalog, budget);
    const matchCut = formatted.techniques.find((t) => t.id === "match_cut");
    const jumpCut = formatted.techniques.find((t) => t.id === "jump_cut");
    const zoom = formatted.techniques.find((t) => t.id === "zoom_punch_in");
    assert.equal(matchCut?.renderSupport, "stub");
    assert.equal(jumpCut?.renderSupport, "partial");
    assert.equal(zoom?.renderSupport, undefined);
  });
});
