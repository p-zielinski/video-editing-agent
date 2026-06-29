import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildColorGradeFilters } from "./color-grade.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NEUTRAL_LUT_CUBE = path.join(ROOT, "assets", "luts", "neutral_vlog.cube");
const WARM_LUT_CUBE = path.join(ROOT, "assets", "luts", "warm_golden_hour.cube");

describe("color-grade", () => {
  it("builds eq filter from exposure, contrast, saturation", () => {
    const filters = buildColorGradeFilters({
      exposure: 0.05,
      contrast: 0.1,
      saturation: -0.05,
    });
    assert.equal(filters.length, 1);
    assert.ok(filters[0].startsWith("eq="));
    assert.ok(filters[0].includes("brightness=0.05"));
    assert.ok(filters[0].includes("contrast=1.1"));
    assert.ok(filters[0].includes("saturation=0.95"));
  });

  it("returns empty array when colorGrade is null", () => {
    assert.deepEqual(buildColorGradeFilters(null), []);
  });

  it("returns empty array for unknown lutId without file", () => {
    const filters = buildColorGradeFilters({ lutId: "nonexistent_lut_xyz" });
    assert.deepEqual(filters, []);
  });

  it("includes only eq when partial grade specified", () => {
    const filters = buildColorGradeFilters({ contrast: 0.2 });
    assert.equal(filters.length, 1);
    assert.equal(filters[0], "eq=contrast=1.2");
  });

  it("includes lut3d filter when catalog cube exists on disk", () => {
    assert.equal(fs.existsSync(NEUTRAL_LUT_CUBE), true);
    const filters = buildColorGradeFilters({ lutId: "neutral_vlog" });
    assert.equal(filters.length, 1);
    assert.ok(filters[0].startsWith("lut3d=file='"));
    assert.ok(filters[0].includes("neutral_vlog.cube"));
  });

  it("includes lut3d filter when warm_golden_hour cube exists on disk", () => {
    assert.equal(fs.existsSync(WARM_LUT_CUBE), true);
    const filters = buildColorGradeFilters({ lutId: "warm_golden_hour" });
    assert.equal(filters.length, 1);
    assert.ok(filters[0].startsWith("lut3d=file='"));
    assert.ok(filters[0].includes("warm_golden_hour.cube"));
  });

  it("applies eq before lut3d when both are specified", () => {
    assert.equal(fs.existsSync(NEUTRAL_LUT_CUBE), true);
    const filters = buildColorGradeFilters({
      lutId: "neutral_vlog",
      exposure: 0.05,
    });
    assert.equal(filters.length, 2);
    assert.ok(filters[0].startsWith("eq="));
    assert.ok(filters[1].startsWith("lut3d="));
  });
});
