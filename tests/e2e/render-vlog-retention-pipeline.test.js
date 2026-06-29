import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeRender, isFfmpegAvailable } from "../../src/render/execute-render.js";
import { buildRenderEdl } from "../../src/render/build-render-edl.js";
import { resolveRenderContext } from "../../src/render/resolve-render-context.js";
import { probeDuration } from "../../src/lib/ffmpeg.js";
import { resolveFfmpegBins } from "../../src/lib/ffmpeg-bin.js";
import { enrichRecipeChapterCards } from "../../src/editorial/chapter-hints.js";
import { enrichRecipeRetentionBeats } from "../../src/editorial/shorts-retention.js";
import {
  cleanupWorkDir,
  copyFixtureToWorkDir,
  loadFixtureArtifact,
} from "../../src/test-helpers/fixture-work-dir.js";
import { writeJson, ARTIFACTS, readJson } from "../../src/pipeline/work-paths.js";

const MAIN_DURATION_SEC = 300;
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

function injectSparseVlogRetentionRecipe(recipe) {
  const main = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
  assert.ok(main, "fixture must include horizontal_main");

  main.targetDurationSec = MAIN_DURATION_SEC;
  main.timeline = [
    {
      segmentId: "seg_h1",
      segmentRole: "aroll",
      videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 150,
      audioInSec: 0,
      audioOutSec: 150,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
      textOverlays: [],
    },
    {
      segmentId: "seg_h2",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 5,
      videoOutSec: 20,
      audioInSec: 130,
      audioOutSec: 145,
      audioPolicy: "from_audio_ref",
      syncMode: "loop_video",
      overlapSec: 0,
      cuts: [],
      textOverlays: [],
    },
    {
      segmentId: "seg_h3",
      segmentRole: "aroll",
      videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
      videoInSec: 150,
      videoOutSec: MAIN_DURATION_SEC,
      audioInSec: 150,
      audioOutSec: MAIN_DURATION_SEC,
      audioPolicy: "from_prev",
      overlapSec: 0,
      cuts: [],
      textOverlays: [],
    },
  ];

  recipe.vlogRetentionProfile = {
    enabled: true,
    retentionBeatIntervalSec: 45,
    retentionBeatToleranceSec: 8,
    minRetentionBeats: 4,
  };

  recipe.creativeMoments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === "short_9x16",
  );

  recipe.audioMixPlan = {
    voiceTargetLufs: -16,
    preWhisperNormalizeLufs: -18,
    musicBed: {
      trackId: "upbeat_vlog_01",
      volumeDb: -20,
      duckingDb: -12,
    },
    segments: [
      {
        outputId: "horizontal_main",
        musicInSec: 0,
        musicOutSec: MAIN_DURATION_SEC,
        duckUnderVoice: true,
      },
    ],
  };

  return recipe;
}

function patchAudioIndexForRetention(workDir) {
  const audioIndexPath = path.join(workDir, ARTIFACTS.audioIndex);
  const audioIndex = readJson(audioIndexPath);
  audioIndex.clips[0].energyPeaks = [
    { startSec: 39, endSec: 41, rmsDb: -12 },
    { startSec: 84, endSec: 88, rmsDb: -10 },
    { startSec: 129, endSec: 133, rmsDb: -11 },
    { startSec: 174, endSec: 178, rmsDb: -9 },
  ];
  writeJson(audioIndexPath, audioIndex);
  return audioIndex;
}

function setupPipelineRenderWorkDir(prefix) {
  const workDir = copyFixtureToWorkDir("mini-day", { prefix });
  workDirs.push(workDir);

  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-inbox-`));
  workDirs.push(inboxDir);

  createLavfiMp4(path.join(inboxDir, "01_talk.MOV"), {
    width: 1920,
    height: 1080,
    duration: MAIN_DURATION_SEC + 20,
  });
  createLavfiMp4(path.join(inboxDir, "02_broll.MOV"), {
    width: 1920,
    height: 1080,
    duration: 45,
  });

  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  catalog.clips[0].sourcePath = path.join(inboxDir, "01_talk.MOV");
  catalog.clips[0].durationSec = MAIN_DURATION_SEC + 20;
  catalog.clips[1].sourcePath = path.join(inboxDir, "02_broll.MOV");
  writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), catalog);

  const audioIndex = patchAudioIndexForRetention(workDir);
  const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
  const timelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));

  let recipe = injectSparseVlogRetentionRecipe(
    loadFixtureArtifact("mini-day", "golden-recipe-v2.json"),
  );

  recipe.creativeMoments = enrichRecipeRetentionBeats(recipe, {
    audioIndex,
    abstraction,
    timelineIndex,
  });
  enrichRecipeChapterCards(recipe, { abstraction });

  writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

  return { workDir, recipe, audioIndex, abstraction, timelineIndex };
}

function expectedEdlDuration(recipe, workDir) {
  const context = resolveRenderContext(workDir, recipe);
  const output = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
  return buildRenderEdl(output, recipe, context).durationSec;
}

function collectMainChapterOverlays(recipe) {
  const main = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
  return (main?.timeline ?? []).flatMap((seg) =>
    (seg.textOverlays ?? []).filter((overlay) => overlay.style === "chapter_card"),
  );
}

describe("render E2E — vlog retention enrich pipeline", () => {
  it("enriches sparse recipe then renders horizontal_main without RENDER_FATAL", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupPipelineRenderWorkDir("vea-render-vlog-pipeline");
    const expectedDuration = expectedEdlDuration(recipe, workDir);

    const enrichedBeats = recipe.creativeMoments.filter(
      (moment) =>
        moment.outputId === "horizontal_main"
        && moment.momentId.startsWith("enrich_beat_"),
    );
    const chapterOverlays = collectMainChapterOverlays(recipe);

    assert.ok(
      enrichedBeats.length >= 1 || chapterOverlays.length >= 1,
      "expected enrich_beat_* moments or chapter_card overlays on main",
    );

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const manifestPath = path.join(workDir, ARTIFACTS.renderManifest);
    assert.equal(fs.existsSync(manifestPath), true);

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath, "expected rendered MP4 path in manifest");
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.equal(entry.skipped, false);

    const allWarnings = [
      ...(manifest.warnings ?? []),
      ...(entry.warnings ?? []),
    ];
    assert.ok(
      !allWarnings.some((w) => w.code === "RENDER_FATAL"),
      `unexpected RENDER_FATAL: ${JSON.stringify(allWarnings)}`,
    );
    assert.ok(!entry.warnings?.some((w) => w.fatal));

    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - expectedDuration) <= 2,
      `expected ~${expectedDuration}s, got ${duration}s`,
    );
  });
});
