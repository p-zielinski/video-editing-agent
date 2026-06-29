import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDrawtextFilters } from "./ffmpeg-graphics.js";
import { DEFAULT_RENDER_STYLE_PRESETS } from "./style-presets.js";

describe("ffmpeg-graphics", () => {
  it("applies stroke border and uppercase transform from hook_large preset", () => {
    const [filter] = buildDrawtextFilters(
      [{
        text: "hello world",
        style: "hook_large",
        outputStartSec: 0,
        outputEndSec: 2.5,
      }],
      {
        dimensions: { width: 1080, height: 1920 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
      },
    );

    assert.ok(filter.includes("borderw=3"));
    assert.ok(filter.includes("bordercolor=0x000000"));
    assert.ok(filter.includes("HELLO WORLD"));
    assert.ok(filter.includes("fontsize=72"));
  });

  it("omits border when preset has no stroke", () => {
    const [filter] = buildDrawtextFilters(
      [{
        text: "caption",
        style: "caption_bar",
        outputStartSec: 1,
        outputEndSec: 3,
      }],
      {
        dimensions: { width: 1920, height: 1080 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
      },
    );

    assert.ok(!filter.includes("borderw="));
    assert.ok(!filter.includes("bordercolor="));
    assert.ok(filter.includes("caption"));
  });

  it("respects explicit position override", () => {
    const [filter] = buildDrawtextFilters(
      [{
        text: "CTA",
        style: "emphasis",
        position: "bottom_center",
        outputStartSec: 5,
        outputEndSec: 8,
      }],
      {
        dimensions: { width: 1920, height: 1080 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
      },
    );

    assert.ok(filter.includes("y=h-text_h-108"));
    assert.ok(filter.includes("enable='between(t,5,8)'"));
  });

  it("clamps drawtext position inside 9:16 safeZone margins", () => {
    const [filter] = buildDrawtextFilters(
      [{
        text: "HOOK",
        style: "hook_large",
        position: "bottom_center",
        outputStartSec: 0,
        outputEndSec: 2,
      }],
      {
        dimensions: { width: 1080, height: 1920 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
        format: "9:16",
      },
    );

    assert.ok(filter.includes("'max(48,min(w-text_w-48"));
    assert.ok(filter.includes("'max(120,min(h-text_h-200"));
  });
});
