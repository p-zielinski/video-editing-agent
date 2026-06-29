import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeRender, isLibassAvailable } from "./execute-render.js";
import { buildSegmentFfmpegArgs } from "./ffmpeg-segment.js";
import { resolvePostConcatCreativeMoments } from "./ffmpeg-concat.js";
import {
  loadFixtureArtifact,
  copyFixtureToWorkDir,
  cleanupWorkDir,
} from "../test-helpers/fixture-work-dir.js";
import { writeJson, ARTIFACTS, readJson } from "../pipeline/work-paths.js";
import path from "node:path";
import fs from "node:fs";
import { seedClipSourceFiles } from "../test-helpers/seed-clip-sources.js";

function outputPathFromFfmpegArgs(args) {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i];
    if (typeof arg === "string" && !arg.startsWith("-") && /\.(mp4|mov|wav|ass)$/i.test(arg)) {
      return arg;
    }
  }
  return null;
}

describe("executeRender", () => {
  it("dry-run returns EDL manifest without FFmpeg", async () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-render" });
    try {
      seedClipSourceFiles(workDir);
      const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
      writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

      const { manifest, results } = await executeRender(workDir, { dryRun: true });

      assert.equal(manifest.batchId, recipe.batchId);
      assert.equal(manifest.outputs.length, 2);
      assert.ok(results[0].edl);
      assert.equal(results[0].edl.segments.length, 3);
      assert.equal(results[1].edl.format, "9:16");

      const horizontal = manifest.outputs.find((o) => o.outputId === "horizontal_main");
      assert.ok(horizontal?.segmentWarnings);
      assert.ok(
        horizontal.segmentWarnings.some((w) => w.code === "broll_av_desync" && w.segmentId === "seg_h2"),
      );
      assert.ok(horizontal.warnings?.some((w) => w.code === "broll_av_desync"));
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("dry-run horizontal_main EDL durationSec matches golden timeline", async () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-render-edl-dur" });
    try {
      seedClipSourceFiles(workDir);
      const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
      writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

      const { results } = await executeRender(workDir, { dryRun: true });
      const horizontal = results.find((r) => r.edl.outputId === "horizontal_main");
      assert.ok(horizontal?.edl);
      assert.equal(horizontal.edl.durationSec, 61.8);
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("mocked render runs pipeline for one output without real FFmpeg", async () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-render-mock" });
    try {
      seedClipSourceFiles(workDir);
      const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
      writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

      const segmentCalls = [];
      let runFfmpegCalls = 0;
      const mockRunFfmpeg = async (args) => {
        runFfmpegCalls += 1;
        const out = outputPathFromFfmpegArgs(args);
        if (out) {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, "stub-mp4");
        }
      };
      const mockRenderSegment = async (segment, context, outputPath, segOptions) => {
        segmentCalls.push({ segmentId: segment.segmentId, outputPath });
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "stub-seg");
        const { warnings } = buildSegmentFfmpegArgs(segment, context, outputPath, segOptions);
        return { outputPath, warnings };
      };

      const { manifest, results } = await executeRender(workDir, {
        outputId: "horizontal_main",
        skipFfmpegCheck: true,
        force: true,
        renderSegmentToFile: mockRenderSegment,
        runFfmpeg: mockRunFfmpeg,
        probeDuration: async () => 61.8,
      });

      assert.equal(segmentCalls.length, 3);
      assert.ok(runFfmpegCalls > 0, "expected downstream FFmpeg passes (concat/mix/grade)");

      assert.equal(manifest.outputs.length, 1);
      const entry = manifest.outputs[0];
      assert.equal(entry.outputId, "horizontal_main");
      assert.equal(entry.format, "16:9");
      assert.equal(entry.outputKind, "main");
      assert.equal(entry.skipped, false);
      assert.ok(entry.outputPath);
      assert.equal(entry.durationSec, 61.8);
      assert.ok(Array.isArray(entry.segmentWarnings));
      assert.ok(entry.warnings.length >= entry.segmentWarnings.length);

      const desync = entry.segmentWarnings.find((w) => w.code === "broll_av_desync");
      assert.ok(desync);
      assert.equal(desync.segmentId, "seg_h2");

      assert.equal(results.length, 1);
      assert.equal(results[0].segmentWarnings?.length, entry.segmentWarnings.length);
      assert.ok(fs.existsSync(entry.outputPath));

      const manifestPath = path.join(workDir, ARTIFACTS.renderManifest);
      assert.ok(fs.existsSync(manifestPath));
      const savedManifest = readJson(manifestPath);
      assert.equal(savedManifest.outputs.length, 1);
      assert.equal(savedManifest.outputs[0].outputId, "horizontal_main");
      assert.equal(savedManifest.outputs[0].segmentWarnings.length, entry.segmentWarnings.length);
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("records segmentErrors and aborts output when a segment render throws", async () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-render-seg-err" });
    try {
      seedClipSourceFiles(workDir);
      const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
      writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

      const mockRenderSegment = async (segment, context, outputPath, segOptions) => {
        if (segment.segmentId === "seg_h2") {
          throw new Error("segment render failed");
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "stub-seg");
        const { warnings } = buildSegmentFfmpegArgs(segment, context, outputPath, segOptions);
        return { outputPath, warnings };
      };

      const { manifest, results } = await executeRender(workDir, {
        outputId: "horizontal_main",
        skipFfmpegCheck: true,
        force: true,
        renderSegmentToFile: mockRenderSegment,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].outputPath, null);
      assert.equal(results[0].segmentErrors?.length, 1);
      assert.equal(results[0].segmentErrors[0].segmentId, "seg_h2");
      assert.match(results[0].segmentErrors[0].message, /segment render failed/);

      const entry = manifest.outputs[0];
      assert.equal(entry.outputPath, null);
      assert.equal(entry.segmentErrors.length, 1);
      assert.equal(entry.segmentErrors[0].segmentId, "seg_h2");
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("throws when recipe final missing", async () => {
    const workDir = copyFixtureToWorkDir("mini-day", {
      prefix: "vea-render-missing",
      exclude: ["09-edit-recipe-final.json"],
    });
    try {
      await assert.rejects(
        () => executeRender(workDir, { dryRun: true }),
        /09-edit-recipe-final/,
      );
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("isLibassAvailable returns boolean", () => {
    assert.equal(typeof isLibassAvailable(), "boolean");
  });

  it("resolvePostConcatCreativeMoments warns when crossfade cannot be applied at concat", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 10 },
      { outputStartSec: 10, outputEndSec: 20 },
      { outputStartSec: 20, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 40 },
    ];
    const creativeMoments = [
      { techniqueId: "crossfade", outputStartSec: 10, outputEndSec: 10.3 },
      { techniqueId: "crossfade", outputStartSec: 20, outputEndSec: 20.3 },
    ];

    const { moments, warnings } = resolvePostConcatCreativeMoments({
      creativeMoments,
      segments,
      segmentPaths: ["seg0.mp4", "seg1.mp4", "seg2.mp4", "seg3.mp4"],
      appliedCrossfade: false,
    });

    assert.equal(moments.length, 0);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], {
      code: "CROSSFADE_NOT_APPLIED",
      techniqueId: "crossfade",
      message: "requires crossfade at every internal join or exactly one join",
    });
  });
});
