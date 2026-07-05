import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRenderEdl,
  projectHookTitleOverlays,
  projectPatternInterruptTextOverlays,
  projectEmphasisTextOverlays,
  projectChapterCardOverlays,
  prioritizeHookWindow,
  clampCreativeMomentsToHookWindow,
} from "./enrich-render-edl.js";
import { buildRenderEdl } from "./build-render-edl.js";
import { resolveRenderContext } from "./resolve-render-context.js";
import {
  loadFixtureArtifact,
  copyFixtureToWorkDir,
  cleanupWorkDir,
} from "../test-helpers/fixture-work-dir.js";
import { seedClipSourceFiles } from "../test-helpers/seed-clip-sources.js";

describe("enrich-render-edl", () => {
  it("resolves video and audio source paths on segments", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-enrich" });
    try {
      seedClipSourceFiles(workDir);
      const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
      const context = resolveRenderContext(workDir, recipe);
      const output = recipe.outputs.find((o) => o.outputId === "horizontal_main");
      const edl = buildRenderEdl(output, recipe, context);

      assert.ok(edl.segments[0].videoSourcePath?.endsWith("/inbox/01_talk.MOV"));
      assert.ok(edl.segments[1].audioSourcePath?.endsWith("/inbox/01_talk.MOV"));
      assert.ok(edl.segments[1].videoSourcePath?.endsWith("/inbox/02_broll.MOV"));
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("projects hook_title_overlay creativeMoments into textOverlays when missing", () => {
    const segments = [{
      segmentId: "seg_s1",
      outputStartSec: 0,
      outputEndSec: 58,
      textOverlays: [],
      videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
    }];

    const enriched = projectHookTitleOverlays(segments, [
      {
        techniqueId: "hook_title_overlay",
        outputId: "short_9x16",
        outputStartSec: 0,
        outputEndSec: 2.5,
        reason: "Hook tekstowy",
        params: { style: "hook_question", position: "center" },
      },
    ], "short_9x16");

    assert.equal(enriched[0].textOverlays.length, 1);
    assert.equal(enriched[0].textOverlays[0].text, "Hook tekstowy");
    assert.equal(enriched[0].textOverlays[0].role, "hook");
    assert.equal(enriched[0].textOverlays[0].style, "hook_question");
  });

  it("projects emphasis_text creativeMoments into textOverlays with emphasis style", () => {
    const segments = [{
      segmentId: "seg_s1",
      outputStartSec: 0,
      outputEndSec: 58,
      textOverlays: [],
    }];

    const enriched = projectEmphasisTextOverlays(segments, [
      {
        techniqueId: "emphasis_text",
        outputId: "short_9x16",
        outputStartSec: 12,
        outputEndSec: 15,
        params: { text: "3 MILLION VIEWS", position: "center" },
      },
    ], "short_9x16");

    assert.equal(enriched[0].textOverlays.length, 1);
    assert.equal(enriched[0].textOverlays[0].text, "3 MILLION VIEWS");
    assert.equal(enriched[0].textOverlays[0].role, "beat");
    assert.equal(enriched[0].textOverlays[0].style, "emphasis");
    assert.equal(enriched[0].textOverlays[0].position, "center");
  });

  it("projects pattern_interrupt cut_text params.text into textOverlays", () => {
    const segments = [{
      segmentId: "seg_s1",
      outputStartSec: 0,
      outputEndSec: 58,
      textOverlays: [],
    }];

    const enriched = projectPatternInterruptTextOverlays(segments, [
      {
        techniqueId: "pattern_interrupt",
        outputId: "short_9x16",
        outputStartSec: 24,
        outputEndSec: 26,
        params: { mode: "cut_text", text: "WAIT — LOOK AT THIS" },
      },
    ], "short_9x16");

    assert.equal(enriched[0].textOverlays.length, 1);
    assert.equal(enriched[0].textOverlays[0].text, "WAIT — LOOK AT THIS");
    assert.equal(enriched[0].textOverlays[0].role, "beat");
    assert.equal(enriched[0].textOverlays[0].style, "emphasis");
    assert.equal(enriched[0].textOverlays[0].outputStartSec, 24);
    assert.equal(enriched[0].textOverlays[0].outputEndSec, 26);
  });

  it("does not duplicate hook overlays already present", () => {
    const segments = [{
      segmentId: "seg_s1",
      outputStartSec: 0,
      outputEndSec: 58,
      textOverlays: [{
        text: "EXISTING",
        outputStartSec: 0,
        outputEndSec: 2,
        role: "hook",
        style: "hook_large",
      }],
    }];

    const enriched = projectHookTitleOverlays(segments, [
      {
        techniqueId: "hook_title_overlay",
        outputId: "short_9x16",
        outputStartSec: 0,
        outputEndSec: 2.5,
        reason: "Hook tekstowy",
      },
    ], "short_9x16");

    assert.equal(enriched[0].textOverlays.length, 1);
    assert.equal(enriched[0].textOverlays[0].text, "EXISTING");
  });

  it("projects chapter_card creativeMoments into textOverlays", () => {
    const segments = [{
      segmentId: "seg_s1",
      outputStartSec: 0,
      outputEndSec: 58,
      textOverlays: [],
    }];

    const enriched = projectChapterCardOverlays(segments, [
      {
        techniqueId: "chapter_card",
        outputId: "short_9x16",
        outputStartSec: 40,
        outputEndSec: 42,
        params: { label: "Część 2" },
      },
    ], "short_9x16");

    assert.equal(enriched[0].textOverlays.length, 1);
    assert.equal(enriched[0].textOverlays[0].text, "Część 2");
    assert.equal(enriched[0].textOverlays[0].style, "chapter_card");
    assert.equal(enriched[0].textOverlays[0].role, "chapter");
    assert.equal(enriched[0].textOverlays[0].position, "center");
  });

  it("clamps hook overlays to hook window for shorts", () => {
    const segments = [{
      segmentId: "seg_s1",
      textOverlays: [{
        text: "HOOK",
        outputStartSec: 1,
        outputEndSec: 5,
        role: "hook",
        style: "hook_large",
      }],
    }];

    const enriched = prioritizeHookWindow(segments, 3);
    assert.equal(enriched[0].textOverlays[0].outputStartSec, 1);
    assert.equal(enriched[0].textOverlays[0].outputEndSec, 3);
  });

  it("clamps hook creativeMoments to hook window", () => {
    const clamped = clampCreativeMomentsToHookWindow([
      {
        techniqueId: "snap_zoom",
        outputStartSec: 0.5,
        outputEndSec: 4,
        retentionRole: "hook",
      },
      {
        techniqueId: "pattern_interrupt",
        outputStartSec: 24,
        outputEndSec: 26,
        retentionRole: "beat",
      },
    ], 3);

    assert.equal(clamped[0].outputStartSec, 0.5);
    assert.equal(clamped[0].outputEndSec, 3);
    assert.equal(clamped[1].outputStartSec, 24);
    assert.equal(clamped[1].outputEndSec, 26);
  });

  it("enrichRenderEdl attaches clamped creativeMoments for shorts", () => {
    const recipe = {
      shortsRetentionProfile: { enabled: true, hookWindowSec: 3 },
      creativeMoments: [{
        momentId: "cm_late_hook",
        techniqueId: "hook_visual_punch",
        outputId: "short_9x16",
        outputStartSec: 5,
        outputEndSec: 7,
        retentionRole: "hook",
      }],
    };
    const baseEdl = {
      outputId: "short_9x16",
      format: "9:16",
      outputKind: "short",
      durationSec: 58,
      segments: [{ segmentId: "seg_s1", textOverlays: [] }],
    };

    const enriched = enrichRenderEdl(baseEdl, {
      recipe,
      context: { clips: {} },
      output: { outputKind: "short" },
      spatialIndex: null,
    });

    assert.equal(enriched.creativeMoments.length, 1);
    assert.equal(enriched.creativeMoments[0].outputEndSec, 3);
    assert.ok(enriched.creativeMoments[0].outputStartSec <= 2.9);
  });

  it("enrichRenderEdl attaches spatialRef for 9:16 short segment", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-enrich-spatial" });
    try {
      seedClipSourceFiles(workDir);
      const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
      const context = resolveRenderContext(workDir, recipe);
      const output = recipe.outputs.find((o) => o.outputId === "short_9x16");
      const spatialIndex = loadFixtureArtifact("mini-day", "05c-spatial-index.json");
      const baseEdl = {
        outputId: output.outputId,
        format: output.format,
        outputKind: "short",
        durationSec: 58,
        segments: output.timeline.map((seg) => ({
          ...seg,
          outputStartSec: 0,
          outputEndSec: 58,
        })),
      };

      const enriched = enrichRenderEdl(baseEdl, {
        recipe,
        context,
        output,
        spatialIndex,
      });

      assert.ok(enriched.segments[0].spatialRef);
      assert.equal(enriched.segments[0].spatialRef.sceneId, "clip01_scene001");
      assert.ok(Array.isArray(enriched.segments[0].spatialRef.bbox));
    } finally {
      cleanupWorkDir(workDir);
    }
  });
});
