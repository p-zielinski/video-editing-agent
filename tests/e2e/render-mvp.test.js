import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeRender, isFfmpegAvailable } from "../../src/render/execute-render.js";
import { buildRenderEdl } from "../../src/render/build-render-edl.js";
import { resolveRenderContext } from "../../src/render/resolve-render-context.js";
import { probeDuration, probeVideoDimensions } from "../../src/lib/ffmpeg.js";
import { resolveFfmpegBins } from "../../src/lib/ffmpeg-bin.js";
import {
  cleanupWorkDir,
  copyFixtureToWorkDir,
  loadFixtureArtifact,
} from "../../src/test-helpers/fixture-work-dir.js";
import { seedClipSourceFiles } from "../../src/test-helpers/seed-clip-sources.js";
import { writeJson, ARTIFACTS, readJson } from "../../src/pipeline/work-paths.js";

const workDirs = [];

afterEach(() => {
  while (workDirs.length > 0) {
    cleanupWorkDir(workDirs.pop());
  }
});

function createLavfiMp4(targetPath, { width = 320, height = 240, duration = 3 } = {}) {
  const { ffmpeg } = resolveFfmpegBins();
  const result = spawnSync(
    ffmpeg,
    [
      "-y",
      "-f", "lavfi",
      "-i", `color=c=blue:s=${width}x${height}:d=${duration}`,
      "-f", "lavfi",
      "-i", `sine=frequency=440:duration=${duration}`,
      "-t", String(duration),
      "-c:v", "libx264",
      "-c:a", "aac",
      "-shortest",
      targetPath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

function setupMiniDayRenderWorkDir(prefix) {
  const workDir = copyFixtureToWorkDir("mini-day", { prefix });
  workDirs.push(workDir);

  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-inbox-`));
  workDirs.push(inboxDir);

  createLavfiMp4(path.join(inboxDir, "01_talk.MOV"), { width: 1920, height: 1080, duration: 120 });
  createLavfiMp4(path.join(inboxDir, "02_broll.MOV"), { width: 1920, height: 1080, duration: 45 });

  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  catalog.clips[0].sourcePath = path.join(inboxDir, "01_talk.MOV");
  catalog.clips[1].sourcePath = path.join(inboxDir, "02_broll.MOV");
  writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), catalog);

  const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
  writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

  return { workDir, recipe, inboxDir };
}

function expectedEdlDuration(recipe, workDir) {
  const context = resolveRenderContext(workDir, recipe);
  const output = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
  return buildRenderEdl(output, recipe, context).durationSec;
}

describe("render E2E — mini-day lavfi", () => {
  it("dry-run EDL resolves cross-clip B-roll source paths", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-broll-edl" });
    workDirs.push(workDir);
    seedClipSourceFiles(workDir);

    const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
    const context = resolveRenderContext(workDir, recipe);
    const output = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
    const edl = buildRenderEdl(output, recipe, context);

    const segH2 = edl.segments.find((seg) => seg.segmentId === "seg_h2");
    assert.ok(segH2);
    assert.ok(segH2.videoSourcePath.endsWith("02_broll.MOV"));
    assert.ok(segH2.audioSourcePath.endsWith("01_talk.MOV"));
    assert.notEqual(segH2.videoSourcePath, segH2.audioSourcePath);
    assert.equal(segH2.syncMode, "loop_video");
    assert.equal(edl.segments.length, 3);
  });

  it("renders horizontal_main MP4 from fixture recipe", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupMiniDayRenderWorkDir("vea-render-e2e");
    const expectedDuration = expectedEdlDuration(recipe, workDir);

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const manifestPath = path.join(workDir, ARTIFACTS.renderManifest);
    assert.equal(fs.existsSync(manifestPath), true);

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.equal(entry.warnings?.some((w) => w.fatal) ?? false, false);

    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - expectedDuration) <= 1,
      `expected ~${expectedDuration}s, got ${duration}s`,
    );
    assert.ok(
      Math.abs((entry.durationSec ?? duration) - expectedDuration) <= 1,
      `manifest duration ${entry.durationSec} vs EDL ${expectedDuration}`,
    );

    const desyncWarning = entry.warnings?.find(
      (w) => w.code === "broll_av_desync" && w.segmentId === "seg_h2",
    );
    assert.ok(desyncWarning, "expected broll_av_desync warning for seg_h2");

    const desyncSegmentWarning = entry.segmentWarnings?.find(
      (w) => w.code === "broll_av_desync" && w.segmentId === "seg_h2",
    );
    assert.ok(desyncSegmentWarning, "expected broll_av_desync in segmentWarnings for seg_h2");
  });

  it("renders all outputs[] from mini-day golden recipe", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupMiniDayRenderWorkDir("vea-render-all-mvp");

    const { manifest } = await executeRender(workDir, {
      encodeProfile: "draft",
      force: true,
    });

    const manifestPath = path.join(workDir, ARTIFACTS.renderManifest);
    assert.equal(fs.existsSync(manifestPath), true);
    assert.equal(manifest.outputs.length, recipe.outputs.length);
    for (const output of recipe.outputs) {
      const entry = manifest.outputs.find((o) => o.outputId === output.outputId);
      assert.ok(entry?.outputPath);
      assert.equal(fs.existsSync(entry.outputPath), true);
    }
  });

  it("renders short_9x16 with vertical dimensions", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir } = setupMiniDayRenderWorkDir("vea-render-short");

    const { manifest } = await executeRender(workDir, {
      outputId: "short_9x16",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "short_9x16");
    assert.ok(entry?.outputPath);
    const dims = await probeVideoDimensions(entry.outputPath);
    assert.equal(dims.width, 1080);
    assert.equal(dims.height, 1920);
  });

  it("renders 2-segment output with crossfade at boundary (no CROSSFADE_NOT_APPLIED)", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupMiniDayRenderWorkDir("vea-render-crossfade");
    const main = recipe.outputs.find((o) => o.outputId === "horizontal_main");
    main.timeline = [
      main.timeline[0],
      {
        ...main.timeline[1],
        overlapSec: 0,
      },
    ];

    const edl = buildRenderEdl(main, recipe, resolveRenderContext(workDir, recipe));
    const joinSec = edl.segments[1].outputStartSec;

    recipe.creativeMoments = [
      ...(recipe.creativeMoments ?? []).filter((m) => m.outputId !== "horizontal_main"),
      {
        momentId: "cm_crossfade_h",
        techniqueId: "crossfade",
        outputId: "horizontal_main",
        outputStartSec: joinSec,
        outputEndSec: joinSec + 0.3,
        params: { durationSec: 0.3 },
        reason: "Crossfade A-roll to B-roll",
      },
    ];
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.equal(entry.skipped, false);
    assert.ok(
      !entry.warnings?.some((w) => w.code === "CROSSFADE_NOT_APPLIED"),
      `crossfade should apply at 2-segment join (~${joinSec}s): ${JSON.stringify(entry.warnings)}`,
    );
    const duration = await probeDuration(entry.outputPath);
    assert.ok(duration > 5);
  });

  it("records segmentErrors and skips MP4 when seg_h2 source is truncated", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, inboxDir } = setupMiniDayRenderWorkDir("vea-render-seg-err");
    const brollPath = path.join(inboxDir, "02_broll.MOV");
    fs.writeFileSync(brollPath, "");

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry);
    assert.equal(entry.outputPath, null);
    assert.equal(entry.segmentErrors?.length, 1);
    assert.equal(entry.segmentErrors[0].segmentId, "seg_h2");
    assert.ok(entry.segmentErrors[0].message);
  });

  it("renders horizontal_main matching EDL duration with word cuts on seg_h1", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupMiniDayRenderWorkDir("vea-render-word-cuts");
    const context = resolveRenderContext(workDir, recipe);
    const output = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
    const edl = buildRenderEdl(output, recipe, context);

    const segH1 = edl.segments.find((seg) => seg.segmentId === "seg_h1");
    assert.ok(segH1?.cuts?.length);
    const segH1Dur = segH1.outputEndSec - segH1.outputStartSec;
    const rawH1Dur = segH1.videoOutSec - segH1.videoInSec;
    assert.ok(segH1Dur < rawH1Dur, "word cut should shorten seg_h1 vs raw in/out range");

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - edl.durationSec) <= 0.5,
      `expected ~${edl.durationSec}s (word cuts applied), got ${duration}s`,
    );
  });

  it("renders 3-segment output with crossfade at middle join (no CROSSFADE_NOT_APPLIED)", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupMiniDayRenderWorkDir("vea-render-crossfade-3seg");
    const main = recipe.outputs.find((o) => o.outputId === "horizontal_main");
    main.timeline = main.timeline.map((seg) => ({
      ...seg,
      overlapSec: 0,
      audioPolicy: seg.audioPolicy === "from_prev" || seg.audioPolicy === "from_next"
        ? "from_video_ref"
        : seg.audioPolicy,
    }));

    const edl = buildRenderEdl(main, recipe, resolveRenderContext(workDir, recipe));
    assert.equal(edl.segments.length, 3);

    const joinSec = edl.segments[1].outputStartSec;

    recipe.creativeMoments = [
      ...(recipe.creativeMoments ?? []).filter((m) => m.outputId !== "horizontal_main"),
      {
        momentId: "cm_crossfade_h_3seg",
        techniqueId: "crossfade",
        outputId: "horizontal_main",
        outputStartSec: joinSec,
        outputEndSec: joinSec + 0.3,
        params: { durationSec: 0.3 },
        reason: "Crossfade at seg_h1/seg_h2 boundary on 3-segment timeline",
      },
    ];
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.ok(
      !entry.warnings?.some((w) => w.code === "CROSSFADE_NOT_APPLIED"),
      `crossfade should apply at middle join (~${joinSec}s): ${JSON.stringify(entry.warnings)}`,
    );
    const duration = await probeDuration(entry.outputPath);
    assert.ok(duration > 5);
  });

  it("renders 2-segment output with cut_on_beat snap and realigned EDL duration", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupMiniDayRenderWorkDir("vea-render-beat-snap");
    const main = recipe.outputs.find((o) => o.outputId === "horizontal_main");
    main.timeline = [
      main.timeline[0],
      {
        ...main.timeline[1],
        overlapSec: 0,
      },
    ];

    const context = resolveRenderContext(workDir, recipe);
    const edlBefore = buildRenderEdl(main, recipe, context);
    assert.equal(edlBefore.segments.length, 2);

    const joinSec = edlBefore.segments[1].outputStartSec;
    const outgoing = edlBefore.segments[0];
    const sourceJoinSec = joinSec - (outgoing.outputStartSec ?? 0) + (outgoing.audioInSec ?? 0);
    const beatSourceSec = Math.max(0, sourceJoinSec - 0.2);

    const audioIndex = readJson(path.join(workDir, ARTIFACTS.audioIndex));
    const clip01 = audioIndex.clips.find((c) => c.clipId === "clip01");
    clip01.beatTimes = [beatSourceSec, beatSourceSec + 0.5, beatSourceSec + 1.0];
    writeJson(path.join(workDir, ARTIFACTS.audioIndex), audioIndex);

    recipe.creativeMoments = [
      ...(recipe.creativeMoments ?? []).filter((m) => m.outputId !== "horizontal_main"),
      {
        momentId: "cm_cut_on_beat_h",
        techniqueId: "cut_on_beat",
        outputId: "horizontal_main",
        outputStartSec: joinSec,
        outputEndSec: joinSec + 0.1,
        params: { snapToleranceSec: 0.5 },
        reason: "Snap A-roll to B-roll join on beat",
      },
    ];
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const expectedDuration = edlBefore.durationSec - 0.2;

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);

    const snapWarning = entry.warnings?.find((w) => w.code === "CUT_ON_BEAT_SNAPPED");
    assert.ok(
      snapWarning,
      `expected CUT_ON_BEAT_SNAPPED in ${JSON.stringify(entry.warnings)}`,
    );
    assert.ok(Math.abs(snapWarning.deltaSec + 0.2) < 0.05);

    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - expectedDuration) <= 0.5,
      `expected ~${expectedDuration}s after beat snap, got ${duration}s (pre-snap EDL ${edlBefore.durationSec}s)`,
    );
  });
});
