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
import {
  cleanupWorkDir,
  copyFixtureToWorkDir,
  loadFixtureArtifact,
} from "../../src/test-helpers/fixture-work-dir.js";
import { writeJson, ARTIFACTS, readJson } from "../../src/pipeline/work-paths.js";

const MAIN_DURATION_SEC = 180;
const BEAT_TECHNIQUES = ["zoom_slow_push", "ken_burns_light", "music_swell", "silence_beat"];
const BEAT_START_SEC = [40, 85, 130, 170];

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

function injectLongMainVlogRetentionRecipe(recipe) {
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
      videoOutSec: 90,
      audioInSec: 0,
      audioOutSec: 90,
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
      audioInSec: 70,
      audioOutSec: 85,
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
      videoInSec: 90,
      videoOutSec: MAIN_DURATION_SEC,
      audioInSec: 90,
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

  const shortMoments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === "short_9x16",
  );
  const mainBeats = BEAT_START_SEC.map((startSec, index) => ({
    momentId: `cm_main_beat${index + 1}`,
    techniqueId: BEAT_TECHNIQUES[index],
    outputId: "horizontal_main",
    outputStartSec: startSec,
    outputEndSec: startSec + 0.9,
    retentionRole: "beat",
    reason: `Vlog retention beat ${index + 1} — ${BEAT_TECHNIQUES[index]}`,
    ...(BEAT_TECHNIQUES[index] === "zoom_slow_push"
      ? {
        spatialRef: {
          clipId: "clip01",
          sceneId: "clip01_scene001",
          anchorType: "face",
          bbox: [0.4, 0.2, 0.5, 0.4],
          timestampSec: 8.5,
        },
      }
      : {}),
  }));

  recipe.creativeMoments = [...shortMoments, ...mainBeats];

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

function setupVlogRetentionRenderWorkDir(prefix) {
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

  const recipe = injectLongMainVlogRetentionRecipe(
    loadFixtureArtifact("mini-day", "golden-recipe-v2.json"),
  );
  writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

  return { workDir, recipe, inboxDir };
}

function expectedEdlDuration(recipe, workDir) {
  const context = resolveRenderContext(workDir, recipe);
  const output = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
  return buildRenderEdl(output, recipe, context).durationSec;
}

describe("render E2E — vlog retention long main", () => {
  it("renders horizontal_main with 4 vlog retention beats without fatal or unsupported techniques", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupVlogRetentionRenderWorkDir("vea-render-vlog-retention");
    const expectedDuration = expectedEdlDuration(recipe, workDir);

    const mainBeats = recipe.creativeMoments.filter(
      (moment) => moment.outputId === "horizontal_main" && moment.retentionRole === "beat",
    );
    assert.ok(mainBeats.length >= 4, "recipe must include 4+ retention beats on main");
    assert.equal(recipe.vlogRetentionProfile?.enabled, true);

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

    for (const techniqueId of BEAT_TECHNIQUES) {
      const unsupported = allWarnings.find(
        (w) => w.techniqueId === techniqueId && w.code === "TECHNIQUE_UNSUPPORTED",
      );
      assert.ok(
        !unsupported,
        `expected ${techniqueId} to be supported on long main vlog retention render`,
      );
    }

    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - expectedDuration) <= 2,
      `expected ~${expectedDuration}s, got ${duration}s`,
    );
    assert.ok(
      Math.abs((entry.durationSec ?? duration) - expectedDuration) <= 2,
      `manifest duration ${entry.durationSec} vs EDL ${expectedDuration}`,
    );
    assert.ok(duration >= 60, "long main output should exceed 60s");
  });
});
