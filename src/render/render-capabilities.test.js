import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RENDER_SUPPORT_LEVELS,
  SEGMENT_RENDER_FEATURES,
  getSegmentRenderFeatureSupport,
  getTechniqueRenderSupport,
  isSyncSpeedSupported,
  TECHNIQUE_RENDER_SUPPORT,
} from "./render-capabilities.js";

const TECHNIQUES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../techniques",
);

function listTechniqueJsonFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "packs") {
      files.push(...listTechniqueJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "_schema.json" && entry.name !== "catalog.meta.json") {
      files.push(full);
    }
  }
  return files;
}

describe("render-capabilities", () => {
  it("RENDER_SUPPORT_LEVELS lists all support tiers", () => {
    assert.deepEqual(RENDER_SUPPORT_LEVELS, [
      "full",
      "partial",
      "stub",
      "audio_only",
      "graphics_only",
      "segment_only",
    ]);
  });

  it("maps known techniques to expected render support", () => {
    assert.equal(getTechniqueRenderSupport("zoom_punch_in"), "full");
    assert.equal(getTechniqueRenderSupport("jump_cut"), "partial");
    assert.equal(getTechniqueRenderSupport("match_cut"), "stub");
    assert.equal(getTechniqueRenderSupport("music_swell"), "audio_only");
    assert.equal(getTechniqueRenderSupport("hook_title_overlay"), "graphics_only");
    assert.equal(getTechniqueRenderSupport("j_cut"), "segment_only");
    assert.equal(getTechniqueRenderSupport("unknown_technique"), null);
  });

  it("isSyncSpeedSupported rejects incompatible syncMode + speed combos", () => {
    assert.equal(isSyncSpeedSupported("align_start", 2, "video_audio"), true);
    assert.equal(isSyncSpeedSupported("fit_video_to_audio", 1.5, "video_audio"), false);
    assert.equal(isSyncSpeedSupported("fit_audio_to_video", 2, "video_audio"), false);
    assert.equal(isSyncSpeedSupported("fit_audio_to_video", 2, "video_only"), true);
    assert.equal(isSyncSpeedSupported("loop_video", 2, "video_audio"), true);
  });

  it("documents reverse and boomerang as segment-only features", () => {
    assert.equal(
      SEGMENT_RENDER_FEATURES["videoTransform.playbackMode:reverse"],
      "segment_only",
    );
    assert.equal(
      getSegmentRenderFeatureSupport("videoTransform.playbackMode:boomerang"),
      "segment_only",
    );
  });

  it("every technique JSON has renderSupport matching the mapping", () => {
    const files = listTechniqueJsonFiles(TECHNIQUES_ROOT);
    assert.ok(files.length > 0);
    for (const filePath of files) {
      const technique = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const expected = TECHNIQUE_RENDER_SUPPORT[technique.id];
      assert.ok(expected, `missing mapping for ${technique.id}`);
      assert.equal(
        technique.renderSupport,
        expected,
        `${technique.id} renderSupport mismatch in ${path.relative(TECHNIQUES_ROOT, filePath)}`,
      );
    }
  });
});
