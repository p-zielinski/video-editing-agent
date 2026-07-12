import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDrawtextFilters,
  buildOverlayAlphaExpression,
  resolveOverlayAnimation,
} from "./ffmpeg-graphics.js";
import { DEFAULT_RENDER_STYLE_PRESETS } from "./style-presets.js";

function drawtextFilter(filters) {
  return filters.find((entry) => entry.startsWith("drawtext=")) ?? filters[filters.length - 1];
}

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

  it("sanitizes unsafe overlay text as a render-time safeguard", () => {
    const [filter] = buildDrawtextFilters(
      [{
        text: "Morderca i kurwa",
        style: "hook_large",
        outputStartSec: 0,
        outputEndSec: 2.5,
      }],
      {
        dimensions: { width: 1080, height: 1920 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
      },
    );

    assert.equal(filter.includes("MORDERCA"), false);
    assert.equal(filter.includes("KURWA"), false);
    assert.ok(filter.includes("M******A"));
    assert.ok(filter.includes("K***A"));
  });

  it("uses chapter_card documentary preset instead of hook_large fallback", () => {
    const filters = buildDrawtextFilters(
      [{
        text: "Part 2 — The climb",
        style: "chapter_card",
        outputStartSec: 120,
        outputEndSec: 124,
      }],
      {
        dimensions: { width: 1920, height: 1080 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
      },
    );

    const filter = filters.find((entry) => entry.startsWith("drawtext=")) ?? filters[filters.length - 1];
    const drawbox = filters.find((entry) => entry.startsWith("drawbox="));

    assert.ok(drawbox, "expected drawbox for chapter_card background");
    assert.ok(drawbox.includes("drawbox="));
    assert.ok(drawbox.includes("color=0x000000@0.55") || drawbox.includes("color=black@"));
    assert.ok(filter.includes("fontsize=44"));
    assert.ok(!filter.includes("fontsize=72"));
    assert.ok(filter.includes("Part 2"));
    assert.ok(!filter.includes("borderw="));
  });

  it("omits border when preset has no stroke", () => {
    const filter = drawtextFilter(buildDrawtextFilters(
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
    ));

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

  it("adds alpha fade expression for chapter_card preset (fade default)", () => {
    const filter = drawtextFilter(buildDrawtextFilters(
      [{
        text: "Part 2",
        style: "chapter_card",
        outputStartSec: 10,
        outputEndSec: 14,
      }],
      {
        dimensions: { width: 1920, height: 1080 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
      },
    ));

    assert.ok(filter.includes("alpha='"));
    assert.ok(filter.includes("255*(t-10)/0.3"));
    assert.ok(filter.includes("255*(14-t)/0.3"));
    assert.ok(filter.includes("enable='between(t,10,14)'"));
  });

  it("omits alpha for hook_large static preset", () => {
    const [filter] = buildDrawtextFilters(
      [{
        text: "HOOK",
        style: "hook_large",
        outputStartSec: 0,
        outputEndSec: 2.5,
      }],
      {
        dimensions: { width: 1080, height: 1920 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
      },
    );

    assert.ok(!filter.includes("alpha='"));
  });

  it("respects per-overlay animation override over style preset", () => {
    const [staticHook] = buildDrawtextFilters(
      [{
        text: "HOOK",
        style: "hook_large",
        animation: "fade",
        outputStartSec: 0,
        outputEndSec: 3,
      }],
      {
        dimensions: { width: 1080, height: 1920 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
      },
    );
    const [staticEmphasis] = buildDrawtextFilters(
      [{
        text: "WOW",
        style: "emphasis",
        animation: "static",
        outputStartSec: 5,
        outputEndSec: 8,
      }],
      {
        dimensions: { width: 1920, height: 1080 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
      },
    );

    assert.ok(staticHook.includes("alpha='"));
    assert.ok(!staticEmphasis.includes("alpha='"));
  });

  it("buildOverlayAlphaExpression clamps fade to half duration for short overlays", () => {
    const alpha = buildOverlayAlphaExpression(1, 1.4);
    assert.ok(alpha.includes("255*(t-1)/0.2"));
    assert.ok(alpha.includes("255*(1.4-t)/0.2"));
  });

  it("resolveOverlayAnimation prefers overlay, then style preset, then fade", () => {
    assert.equal(
      resolveOverlayAnimation({ animation: "static" }, { animation: "fade" }),
      "static",
    );
    assert.equal(
      resolveOverlayAnimation({}, DEFAULT_RENDER_STYLE_PRESETS.overlays.cta),
      "fade",
    );
    assert.equal(
      resolveOverlayAnimation({}, DEFAULT_RENDER_STYLE_PRESETS.overlays.hook_large),
      "static",
    );
    assert.equal(resolveOverlayAnimation({}, {}), "fade");
  });

  it("adds slide_up position expression and alpha for slide animations", () => {
    const filter = drawtextFilter(buildDrawtextFilters(
      [{
        text: "Part 2",
        style: "chapter_card",
        animation: "slide_up",
        outputStartSec: 10,
        outputEndSec: 14,
      }],
      {
        dimensions: { width: 1920, height: 1080 },
        stylePresets: DEFAULT_RENDER_STYLE_PRESETS,
      },
    ));

    assert.ok(filter.includes("alpha='"));
    assert.ok(filter.includes("if(lt(t\\,10)"));
    assert.ok(filter.includes("1080"));
  });
});
