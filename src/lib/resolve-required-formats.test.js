import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REQUIRED_FORMATS,
  normalizeRequiredFormats,
  resolveEffectiveRequiredFormats,
  resolveFormatsSource,
} from "./resolve-required-formats.js";

describe("resolve-required-formats", () => {
  it("normalizes and deduplicates valid formats", () => {
    assert.deepEqual(normalizeRequiredFormats(["9:16", "9:16", "bogus", "16:9"]), ["9:16", "16:9"]);
  });

  it("uses L3 when CLI did not explicitly override", () => {
    assert.deepEqual(
      resolveEffectiveRequiredFormats({
        cliFormats: DEFAULT_REQUIRED_FORMATS,
        cliExplicit: false,
        l3RecommendedFormats: ["9:16"],
      }),
      ["9:16"],
    );
  });

  it("CLI --min-outputs wins over L3", () => {
    assert.deepEqual(
      resolveEffectiveRequiredFormats({
        cliFormats: ["16:9"],
        cliExplicit: true,
        l3RecommendedFormats: ["9:16"],
      }),
      ["16:9"],
    );
  });

  it("context requiredFormats wins over L3", () => {
    assert.deepEqual(
      resolveEffectiveRequiredFormats({
        cliFormats: DEFAULT_REQUIRED_FORMATS,
        cliExplicit: false,
        contextFormats: ["16:9"],
        contextExplicit: true,
        l3RecommendedFormats: ["9:16"],
      }),
      ["16:9"],
    );
  });

  it("falls back to defaults when L3 is empty", () => {
    assert.deepEqual(
      resolveEffectiveRequiredFormats({
        cliFormats: DEFAULT_REQUIRED_FORMATS,
        cliExplicit: false,
        l3RecommendedFormats: [],
      }),
      DEFAULT_REQUIRED_FORMATS,
    );
  });

  it("resolveFormatsSource reflects override vs L3", () => {
    assert.equal(resolveFormatsSource({ cliExplicit: true }), "explicit");
    assert.equal(resolveFormatsSource({ l3RecommendedFormats: ["9:16"] }), "l3");
    assert.equal(resolveFormatsSource({}), "default");
  });
});
