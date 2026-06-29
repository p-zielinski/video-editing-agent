import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeRender, isFfmpegAvailable, isLibassAvailable } from "../../src/render/execute-render.js";
import { buildRenderEdl } from "../../src/render/build-render-edl.js";
import { resolveRenderContext } from "../../src/render/resolve-render-context.js";
import { generateAssSubtitles } from "../../src/render/ass-subtitles.js";
import { resolveStylePresets } from "../../src/render/render-config.js";
import { probeDuration, probeVideoDimensions } from "../../src/lib/ffmpeg.js";
import { resolveFfmpegBins } from "../../src/lib/ffmpeg-bin.js";
import {
  cleanupWorkDir,
  copyFixtureToWorkDir,
  loadFixtureArtifact,
} from "../../src/test-helpers/fixture-work-dir.js";
import { writeJson, ARTIFACTS } from "../../src/pipeline/work-paths.js";

const workDirs = [];

afterEach(() => {
  while (workDirs.length > 0) {
    cleanupWorkDir(workDirs.pop());
  }
});

function createLavfiMp4(targetPath, { width = 320, height = 240, duration = 3, color = "blue" } = {}) {
  const { ffmpeg } = resolveFfmpegBins();
  const result = spawnSync(
    ffmpeg,
    [
      "-y",
      "-f", "lavfi",
      "-i", `color=c=${color}:s=${width}x${height}:d=${duration}`,
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

function createLavfiWav(targetPath, { duration = 20, frequency = 220 } = {}) {
  const { ffmpeg } = resolveFfmpegBins();
  const result = spawnSync(
    ffmpeg,
    [
      "-y",
      "-f", "lavfi",
      "-i", `sine=frequency=${frequency}:duration=${duration}`,
      "-t", String(duration),
      targetPath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

function setupVoiceoverRenderWorkDir(prefix) {
  const workDir = copyFixtureToWorkDir("voiceover-day", { prefix });
  workDirs.push(workDir);

  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-inbox-`));
  workDirs.push(inboxDir);

  createLavfiMp4(path.join(inboxDir, "01_broll_city.MOV"), {
    width: 1920,
    height: 1080,
    duration: 30,
    color: "teal",
  });
  createLavfiMp4(path.join(inboxDir, "02_broll_food.MOV"), {
    width: 1920,
    height: 1080,
    duration: 25,
    color: "orange",
  });
  createLavfiWav(path.join(inboxDir, "03_narration.wav"), { duration: 20 });

  const catalog = JSON.parse(fs.readFileSync(path.join(workDir, ARTIFACTS.sceneCatalog), "utf8"));
  for (const clip of catalog.clips) {
    clip.sourcePath = path.join(inboxDir, clip.fileName);
  }
  for (const scene of catalog.scenes) {
    const clip = catalog.clips.find((c) => c.clipId === scene.clipId);
    scene.sourcePath = clip.sourcePath;
  }
  writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), catalog);

  const recipe = loadFixtureArtifact("voiceover-day", "golden-recipe-v2.json");
  writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

  return { workDir, recipe, inboxDir };
}

function expectedEdlDuration(recipe, workDir, outputId = "horizontal_main") {
  const context = resolveRenderContext(workDir, recipe);
  const output = recipe.outputs.find((entry) => entry.outputId === outputId);
  return buildRenderEdl(output, recipe, context).durationSec;
}

describe("render E2E — voiceover-day lavfi", () => {
  it("dry-run EDL resolves broll video and narration audio paths", () => {
    const { workDir, recipe } = setupVoiceoverRenderWorkDir("vea-vo-edl");
    const context = resolveRenderContext(workDir, recipe);
    const output = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
    const edl = buildRenderEdl(output, recipe, context);

    assert.equal(edl.segments.length, 2);

    const seg1 = edl.segments.find((seg) => seg.segmentId === "seg_vo_01");
    assert.ok(seg1);
    assert.ok(seg1.videoSourcePath.endsWith("01_broll_city.MOV"));
    assert.ok(seg1.audioSourcePath.endsWith("03_narration.wav"));
    assert.notEqual(seg1.videoSourcePath, seg1.audioSourcePath);
    assert.equal(seg1.audioPolicy, "from_audio_ref");

    const seg2 = edl.segments.find((seg) => seg.segmentId === "seg_vo_02");
    assert.ok(seg2);
    assert.ok(seg2.videoSourcePath.endsWith("02_broll_food.MOV"));
    assert.ok(seg2.audioSourcePath.endsWith("03_narration.wav"));
  });

  it("renders horizontal_main MP4 from voiceover fixture recipe", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupVoiceoverRenderWorkDir("vea-vo-render");
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

    const desyncSegmentWarning = entry.segmentWarnings?.find(
      (w) => w.code === "broll_av_desync" && w.segmentId === "seg_vo_01",
    );
    assert.ok(
      desyncSegmentWarning,
      "expected broll_av_desync in segmentWarnings for seg_vo_01 (video 12s vs audio 10s)",
    );
  });

  it("renders short_9x16 with vertical dimensions from voiceover fixture", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupVoiceoverRenderWorkDir("vea-vo-short");
    const expectedDuration = expectedEdlDuration(recipe, workDir, "short_9x16");

    const { manifest } = await executeRender(workDir, {
      outputId: "short_9x16",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "short_9x16");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);

    const dims = await probeVideoDimensions(entry.outputPath);
    assert.equal(dims.width, 1080);
    assert.equal(dims.height, 1920);

    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - expectedDuration) <= 1,
      `expected ~${expectedDuration}s, got ${duration}s`,
    );
    assert.ok(
      Math.abs((entry.durationSec ?? duration) - expectedDuration) <= 1,
      `manifest duration ${entry.durationSec} vs EDL ${expectedDuration}`,
    );
  });

  it("renders short_9x16 with word_by_word ASS burn-in", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }
    if (!isLibassAvailable()) {
      t.skip("libass not available");
    }

    const { workDir, recipe } = setupVoiceoverRenderWorkDir("vea-vo-ass");
    const context = resolveRenderContext(workDir, recipe);
    const output = recipe.outputs.find((entry) => entry.outputId === "short_9x16");
    const edl = buildRenderEdl(output, recipe, context);
    const expectedDuration = edl.durationSec;

    assert.equal(edl.segments[0].subtitles?.policy, "word_by_word");
    const ass = generateAssSubtitles({
      edl,
      context,
      stylePresets: resolveStylePresets(recipe),
      format: "9:16",
    });
    assert.ok(ass.includes("Dialogue:"), "expected ASS dialogue events for voiceover short");

    const { manifest } = await executeRender(workDir, {
      outputId: "short_9x16",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "short_9x16");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.equal(entry.skipped, false);

    const dims = await probeVideoDimensions(entry.outputPath);
    assert.equal(dims.width, 1080);
    assert.equal(dims.height, 1920);

    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - expectedDuration) <= 1,
      `expected ~${expectedDuration}s, got ${duration}s`,
    );
  });

  it("renders audio-only narration segment with lavfi black video", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupVoiceoverRenderWorkDir("vea-vo-audio-only");
    const audioOnlyOutput = {
      outputId: "audio_only_test",
      format: "16:9",
      outputKind: "main",
      targetDurationSec: 5,
      title: "Audio-only narration",
      timeline: [
        {
          segmentId: "seg_narration_only",
          segmentRole: "aroll",
          videoRef: { clipId: "clip03", sceneId: "clip03_scene001" },
          audioRef: { clipId: "clip03", sceneId: "clip03_scene001" },
          videoInSec: 0,
          videoOutSec: 5,
          audioInSec: 0,
          audioOutSec: 5,
          audioPolicy: "from_video_ref",
          syncMode: "align_start",
          overlapSec: 0,
          cuts: [],
          textOverlays: [],
        },
      ],
      chapterMarkers: [],
    };
    recipe.outputs = [audioOnlyOutput];
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const context = resolveRenderContext(workDir, recipe);
    const edl = buildRenderEdl(audioOnlyOutput, recipe, context);
    assert.equal(edl.segments[0].videoSourcePath, null);
    assert.ok(edl.segments[0].audioSourcePath.endsWith("03_narration.wav"));
    assert.equal(edl.durationSec, 5);

    const { manifest } = await executeRender(workDir, {
      outputId: "audio_only_test",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "audio_only_test");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);

    const dims = await probeVideoDimensions(entry.outputPath);
    assert.equal(dims.width, 1920);
    assert.equal(dims.height, 1080);

    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - edl.durationSec) <= 0.5,
      `expected ~${edl.durationSec}s, got ${duration}s`,
    );
  });
});
