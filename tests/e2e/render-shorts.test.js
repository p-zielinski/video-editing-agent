import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeRender, isFfmpegAvailable, isLibassAvailable } from "../../src/render/execute-render.js";
import { buildRenderEdl } from "../../src/render/build-render-edl.js";
import { resolveRenderContext } from "../../src/render/resolve-render-context.js";
import { overlapAtBoundary } from "../../src/render/audio-jlcut.js";
import { probeDuration, probeVideoDimensions, probeAudioStream } from "../../src/lib/ffmpeg.js";
import { resolveFfmpegBins } from "../../src/lib/ffmpeg-bin.js";
import {
  cleanupWorkDir,
  copyFixtureToWorkDir,
  loadFixtureArtifact,
} from "../../src/test-helpers/fixture-work-dir.js";
import { writeJson, ARTIFACTS, readJson } from "../../src/pipeline/work-paths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WHOOSH_SFX_PATH = path.join(ROOT, "assets", "sfx", "whoosh.wav");
const workDirs = [];

afterEach(() => {
  while (workDirs.length > 0) {
    cleanupWorkDir(workDirs.pop());
  }
});

function probeAudioStreams(filePath) {
  const { ffprobe } = resolveFfmpegBins();
  const result = spawnSync(
    ffprobe,
    [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index,codec_type,duration",
      "-of", "json",
      filePath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  const data = JSON.parse(result.stdout);
  return data.streams ?? [];
}

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

function ensureTestMusicBed(workDir) {
  const musicDir = path.join(workDir, "music");
  fs.mkdirSync(musicDir, { recursive: true });
  const bedPath = path.join(musicDir, "test-bed.mp3");
  if (!fs.existsSync(bedPath)) {
    const { ffmpeg } = resolveFfmpegBins();
    const result = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f", "lavfi",
        "-i", "sine=frequency=220:duration=10",
        "-c:a", "libmp3lame",
        "-b:a", "64k",
        bedPath,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
  }

  const catalogPath = path.join(musicDir, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({
    version: "1.0",
    tracks: [{
      trackId: "test_bed_01",
      fileName: "test-bed.mp3",
      title: "Test Bed (E2E)",
      mood: ["test"],
      bpm: 120,
      durationSec: 10,
      integratedLufs: -16,
    }],
  }));

  return bedPath;
}

function setupMiniDayWorkDir(prefix) {
  const workDir = copyFixtureToWorkDir("mini-day", { prefix });
  workDirs.push(workDir);

  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-inbox-`));
  workDirs.push(inboxDir);

  createLavfiMp4(path.join(inboxDir, "01_talk.MOV"), { width: 1920, height: 1080, duration: 120 });
  createLavfiMp4(path.join(inboxDir, "02_broll.MOV"), { duration: 45 });

  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  catalog.clips[0].sourcePath = path.join(inboxDir, "01_talk.MOV");
  catalog.clips[1].sourcePath = path.join(inboxDir, "02_broll.MOV");
  writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), catalog);

  const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
  writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

  return { workDir, recipe };
}

describe("render E2E — all outputs", () => {
  it("renders all outputs[] from mini-day golden recipe", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupMiniDayWorkDir("vea-render-all");

    const { manifest } = await executeRender(workDir, {
      encodeProfile: "draft",
      force: true,
    });

    assert.equal(manifest.outputs.length, recipe.outputs.length);
    for (const output of recipe.outputs) {
      const entry = manifest.outputs.find((o) => o.outputId === output.outputId);
      assert.ok(entry?.outputPath, `missing render for ${output.outputId}`);
      assert.equal(fs.existsSync(entry.outputPath), true);
      assert.equal(entry.skipped, false);
    }
  });
});

describe("render E2E — repo music bed from assets/music/", () => {
  it("renders horizontal_main with golden recipe audioMixPlan (no runtime injection)", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }
    const musicPath = path.join(ROOT, "assets", "music", "upbeat_vlog_01.mp3");
    if (!fs.existsSync(musicPath)) {
      t.skip("assets/music/upbeat_vlog_01.mp3 missing");
    }

    const { workDir, recipe } = setupMiniDayWorkDir("vea-render-repo-music");
    assert.ok(recipe.audioMixPlan?.musicBed?.trackId === "upbeat_vlog_01");

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    const duration = await probeDuration(entry.outputPath);
    assert.ok(duration > 10);
    assert.ok(entry.durationSec > 0, "manifest should record positive duration after mix pass");
    const audio = await probeAudioStream(entry.outputPath);
    assert.equal(audio.codecType, "audio");
    assert.ok(audio.codecName, "expected audio codec in rendered output");
    assert.ok(!entry.warnings?.some((w) => w.fatal));
    assert.ok(!entry.warnings?.some((w) => w.code === "RENDER_FATAL"));
    assert.ok(
      !entry.warnings?.some((w) => w.code === "CROSSFADE_NOT_APPLIED"),
      "unexpected crossfade warning on music bed render",
    );

    const savedManifest = readJson(path.join(workDir, ARTIFACTS.renderManifest));
    const savedEntry = savedManifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.equal(
      savedEntry?.audioMixApplied,
      true,
      "mix pass should set audioMixApplied in 13-render-manifest.json",
    );
  });
});

describe("render E2E — music bed mix", () => {
  it("renders with audioMixPlan music bed and no fatal errors", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-music");
    ensureTestMusicBed(workDir);

    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    recipe.audioMixPlan = {
      voiceTargetLufs: -16,
      musicBed: {
        trackId: "test_bed_01",
        volumeDb: -20,
        duckingDb: -12,
      },
      segments: [
        {
          outputId: "horizontal_main",
          musicInSec: 0,
          musicOutSec: 120,
          duckUnderVoice: true,
        },
      ],
    };
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    const duration = await probeDuration(entry.outputPath);
    assert.ok(duration > 10);
    assert.ok(!manifest.warnings?.some((w) => w.code === "RENDER_FATAL"));

    const savedManifest = readJson(path.join(workDir, ARTIFACTS.renderManifest));
    const savedEntry = savedManifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.equal(savedEntry?.audioMixApplied, true);
  });
});

describe("render E2E — golden creativeMoments on short", () => {
  it("renders short_9x16 with snap_zoom, hook_title_overlay and pattern_interrupt without fatal errors", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupMiniDayWorkDir("vea-render-creative");

    const hookMoment = recipe.creativeMoments?.find(
      (m) => m.outputId === "short_9x16" && m.techniqueId === "hook_title_overlay",
    );
    assert.ok(hookMoment, "golden recipe must include hook_title_overlay for short_9x16");

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

    const allWarnings = [...(manifest.warnings ?? []), ...(entry.warnings ?? [])];
    assert.ok(!allWarnings.some((w) => w.code === "RENDER_FATAL"));

    for (const techniqueId of ["snap_zoom", "pattern_interrupt", "hook_title_overlay"]) {
      const unsupported = (entry.warnings ?? []).find(
        (w) => w.techniqueId === techniqueId && w.code === "TECHNIQUE_UNSUPPORTED",
      );
      assert.ok(!unsupported, `expected ${techniqueId} to be supported`);
    }

    const hookNoOp = (entry.warnings ?? []).find(
      (w) => w.techniqueId === "hook_title_overlay" && w.code === "TECHNIQUE_NO_OP",
    );
    if (hookNoOp) {
      const context = resolveRenderContext(workDir, recipe);
      const output = recipe.outputs.find((o) => o.outputId === "short_9x16");
      const edl = buildRenderEdl(output, recipe, context);
      const hookOverlays = edl.segments.flatMap((seg) => seg.textOverlays ?? [])
        .filter((o) => o.role === "hook" || o.style?.startsWith("hook_"));
      assert.ok(
        hookOverlays.length > 0,
        "enrich should project hook overlay for graphics pass when creative emits TECHNIQUE_NO_OP",
      );
    }
  });
});

describe("render E2E — shorts 9:16 + creativeMoments warnings", () => {
  it("renders short_9x16 and applies music_swell in audio mix when musicBed present", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }
    const musicPath = path.join(ROOT, "assets", "music", "upbeat_vlog_01.mp3");
    if (!fs.existsSync(musicPath)) {
      t.skip("assets/music/upbeat_vlog_01.mp3 missing");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-shorts-swell");

    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    recipe.creativeMoments.push({
      momentId: "cm_music_swell",
      techniqueId: "music_swell",
      outputId: "short_9x16",
      outputStartSec: 5,
      outputEndSec: 8,
      params: { gainDb: 3, durationSec: 3 },
      reason: "Test music swell in audio mix pass",
    });
    recipe.audioMixPlan = {
      ...(recipe.audioMixPlan ?? {}),
      voiceTargetLufs: -16,
      musicBed: {
        trackId: "upbeat_vlog_01",
        volumeDb: -20,
        duckingDb: -12,
      },
      segments: [
        ...(recipe.audioMixPlan?.segments ?? []).filter((s) => s.outputId !== "short_9x16"),
        {
          outputId: "short_9x16",
          musicInSec: 0,
          musicOutSec: 120,
          duckUnderVoice: true,
        },
      ],
    };
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

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

    const swellWarning = (entry.warnings ?? []).find(
      (w) => w.techniqueId === "music_swell" && w.code === "TECHNIQUE_AUDIO_ONLY",
    );
    assert.ok(!swellWarning, "music_swell should be applied in mix, not only warn");
    assert.equal(entry.audioMixApplied, true);
    assert.equal(entry.audioTechniquesApplied, true);
  });

  it("renders short_9x16 and applies music_drop in audio mix when musicBed present", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }
    const musicPath = path.join(ROOT, "assets", "music", "upbeat_vlog_01.mp3");
    if (!fs.existsSync(musicPath)) {
      t.skip("assets/music/upbeat_vlog_01.mp3 missing");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-shorts-drop");

    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    recipe.creativeMoments.push({
      momentId: "cm_music_drop",
      techniqueId: "music_drop",
      outputId: "short_9x16",
      outputStartSec: 5,
      outputEndSec: 8,
      params: { durationSec: 3 },
      reason: "Test music drop in audio mix pass",
    });
    recipe.audioMixPlan = {
      ...(recipe.audioMixPlan ?? {}),
      voiceTargetLufs: -16,
      musicBed: {
        trackId: "upbeat_vlog_01",
        volumeDb: -20,
        duckingDb: -12,
      },
      segments: [
        ...(recipe.audioMixPlan?.segments ?? []).filter((s) => s.outputId !== "short_9x16"),
        {
          outputId: "short_9x16",
          musicInSec: 0,
          musicOutSec: 120,
          duckUnderVoice: true,
        },
      ],
    };
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

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

    const dropWarning = (entry.warnings ?? []).find(
      (w) => w.techniqueId === "music_drop" && w.code === "TECHNIQUE_AUDIO_ONLY",
    );
    assert.ok(!dropWarning, "music_drop should be applied in mix, not only warn");
    assert.equal(entry.audioMixApplied, true);
    assert.equal(entry.audioTechniquesApplied, true);
  });

  it("renders short_9x16 and applies silence_beat in audio mix when audioMixPlan present", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-shorts-silence");
    ensureTestMusicBed(workDir);

    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    recipe.creativeMoments.push({
      momentId: "cm_silence_beat",
      techniqueId: "silence_beat",
      outputId: "short_9x16",
      outputStartSec: 5,
      outputEndSec: 6,
      params: { durationSec: 1 },
      reason: "Test silence beat in audio mix pass",
    });
    recipe.audioMixPlan = {
      ...(recipe.audioMixPlan ?? {}),
      voiceTargetLufs: -16,
      musicBed: {
        trackId: "test_bed_01",
        volumeDb: -20,
        duckingDb: -12,
      },
      segments: [
        ...(recipe.audioMixPlan?.segments ?? []).filter((s) => s.outputId !== "short_9x16"),
        {
          outputId: "short_9x16",
          musicInSec: 0,
          musicOutSec: 120,
          duckUnderVoice: true,
        },
      ],
    };
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

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

    const silenceWarning = (entry.warnings ?? []).find(
      (w) => w.techniqueId === "silence_beat" && w.code === "TECHNIQUE_AUDIO_ONLY",
    );
    assert.ok(!silenceWarning, "silence_beat should be applied in mix, not only warn");
    assert.equal(entry.audioMixApplied, true);
    assert.equal(entry.audioTechniquesApplied, true);
  });
});

describe("render E2E — W4.15 retention techniques", () => {
  it("renders short_9x16 with zoom_punch_out without TECHNIQUE_UNSUPPORTED", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-zoom-punch-out");

    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    recipe.creativeMoments.push({
      momentId: "cm_zoom_punch_out",
      techniqueId: "zoom_punch_out",
      outputId: "short_9x16",
      outputStartSec: 10,
      outputEndSec: 11.5,
      params: { factor: 0.92 },
      spatialRef: {
        clipId: "clip01",
        sceneId: "clip01_scene001",
        anchorType: "face",
        bbox: [0.4, 0.2, 0.5, 0.4],
      },
      reason: "E2E zoom_punch_out creative pass",
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const { manifest } = await executeRender(workDir, {
      outputId: "short_9x16",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "short_9x16");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);

    const unsupported = (entry.warnings ?? []).find(
      (w) => w.techniqueId === "zoom_punch_out" && w.code === "TECHNIQUE_UNSUPPORTED",
    );
    assert.ok(!unsupported, "zoom_punch_out should be supported in creative pass");

    const allWarnings = [...(manifest.warnings ?? []), ...(entry.warnings ?? [])];
    assert.ok(!allWarnings.some((w) => w.code === "RENDER_FATAL"));
  });

  it("renders short_9x16 with dip_to_black without RENDER_FATAL", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-dip-to-black");

    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    recipe.creativeMoments.push({
      momentId: "cm_dip_to_black",
      techniqueId: "dip_to_black",
      outputId: "short_9x16",
      outputStartSec: 15,
      outputEndSec: 15.8,
      params: { durationSec: 0.6 },
      reason: "E2E dip_to_black creative pass",
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const { manifest } = await executeRender(workDir, {
      outputId: "short_9x16",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "short_9x16");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);

    const allWarnings = [...(manifest.warnings ?? []), ...(entry.warnings ?? [])];
    assert.ok(!allWarnings.some((w) => w.code === "RENDER_FATAL"));
  });
});

describe("render E2E — jump_cut creative pass", () => {
  it("renders short_9x16 with jump_cut in creative pass (not deferred to concat)", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-jump-cut");

    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    recipe.creativeMoments.push({
      momentId: "cm_jump_cut",
      techniqueId: "jump_cut",
      outputId: "short_9x16",
      outputStartSec: 10,
      outputEndSec: 10.2,
      reason: "Test jump_cut partial creative pass flash",
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

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

    const deferred = (entry.warnings ?? []).find(
      (w) => w.techniqueId === "jump_cut" && w.code === "TECHNIQUE_DEFERRED_CONCAT",
    );
    assert.ok(!deferred, "jump_cut should be applied in creative pass, not deferred to concat");

    const allWarnings = [...(manifest.warnings ?? []), ...(entry.warnings ?? [])];
    assert.ok(!allWarnings.some((w) => w.code === "RENDER_FATAL"));
  });
});

describe("render E2E — sfxPlan library overlay", () => {
  it("renders with sfxPlan whoosh from assets/sfx/", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }
    if (!fs.existsSync(WHOOSH_SFX_PATH)) {
      t.skip("assets/sfx/whoosh.wav missing");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-sfx");
    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    recipe.sfxPlan = [{
      sfxId: "sfx_whoosh",
      source: "library",
      label: "whoosh",
      outputStartSec: 2,
      outputEndSec: 3,
      volumeDb: -6,
      reason: "E2E sfx overlay",
    }];
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.equal(entry.sfxApplied, true);
    assert.ok(!manifest.warnings?.some((w) => w.code === "RENDER_FATAL"));
  });
});

describe("render E2E — sfxPlan audio_event overlay", () => {
  it("renders with audio_event excerpt from source clip", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-sfx-event");
    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    recipe.sfxPlan = [{
      sfxId: "evt_clip01_5000",
      source: "audio_event",
      clipId: "clip01",
      anchorTimeSec: 5,
      outputStartSec: 2,
      outputEndSec: 3,
      volumeDb: -6,
      label: "laughter",
      reason: "E2E audio_event overlay",
    }];
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.equal(entry.sfxApplied, true);
    assert.ok(!manifest.warnings?.some((w) => w.code === "SFX_UNRESOLVED"));
  });
});

describe("render E2E — colorGrade lut3d", () => {
  it("renders with colorGrade.lutId when neutral_vlog.cube exists", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }
    const lutPath = path.join(ROOT, "assets", "luts", "neutral_vlog.cube");
    if (!fs.existsSync(lutPath)) {
      t.skip("assets/luts/neutral_vlog.cube missing");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-lut");
    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    recipe.colorGrade = {
      lutId: "neutral_vlog",
      exposure: 0.02,
    };
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.ok(!manifest.warnings?.some((w) => w.code === "RENDER_FATAL"));
  });
});

describe("render E2E — ASS subtitles on short", () => {
  it("renders short_9x16 with word_by_word ASS burn-in", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }
    if (!isLibassAvailable()) {
      t.skip("libass not available");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-ass");

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
  });
});

describe("render E2E — J/L-cut with overlapSec", () => {
  it("renders horizontal_main with acrossfade when overlapSec > 0", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-jl");

    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    const main = recipe.outputs.find((o) => o.outputId === "horizontal_main");
    main.timeline[2].audioPolicy = "from_prev";
    main.timeline[2].overlapSec = 1.5;
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const context = resolveRenderContext(workDir, recipe);
    const edl = buildRenderEdl(main, recipe, context);

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
      context,
      recipe,
    });

    assert.ok(manifest.outputs.length > 0);
    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.equal(entry.skipped, false);
    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - edl.durationSec) <= 1,
      `expected duration ~${edl.durationSec}s (±1s), got ${duration}s`,
    );

    const audioStreams = probeAudioStreams(entry.outputPath);
    assert.equal(
      audioStreams.length,
      1,
      `expected exactly one audio stream, got ${audioStreams.length}`,
    );
    const audioDuration = Number(audioStreams[0].duration);
    assert.ok(
      Number.isFinite(audioDuration) && audioDuration > 0,
      "audio stream should have positive duration (not silent)",
    );
    assert.ok(
      Math.abs(audioDuration - edl.durationSec) <= 1,
      `expected audio duration ~${edl.durationSec}s (±1s), got ${audioDuration}s`,
    );

    const allWarnings = [...(manifest.warnings ?? []), ...(entry.warnings ?? [])];
    assert.ok(!allWarnings.some((w) => w.code === "RENDER_FATAL"));
    assert.equal(edl.segments[2].overlapSec, 1.5);
    assert.equal(
      edl.segments[1].outputEndSec,
      edl.segments[2].outputStartSec + 1.5,
      "overlap should extend previous segment audio carry-forward window",
    );
  });

  it("renders horizontal_main with L-cut (from_next) and overlapSec > 0", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir } = setupMiniDayWorkDir("vea-render-lcut");

    const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    const main = recipe.outputs.find((o) => o.outputId === "horizontal_main");
    main.timeline[0].audioPolicy = "from_next";
    main.timeline[0].overlapSec = 1.5;
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const context = resolveRenderContext(workDir, recipe);
    const edl = buildRenderEdl(main, recipe, context);

    const { manifest } = await executeRender(workDir, {
      outputId: "horizontal_main",
      encodeProfile: "draft",
      force: true,
      context,
      recipe,
    });

    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.equal(entry.skipped, false);
    assert.equal(edl.segments[0].audioPolicy, "from_next");
    assert.equal(edl.segments[0].overlapSec, 1.5);
    assert.equal(overlapAtBoundary(edl.segments, 1), 1.5);

    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - edl.durationSec) <= 1,
      `expected duration ~${edl.durationSec}s (±1s), got ${duration}s`,
    );

    const audioStreams = probeAudioStreams(entry.outputPath);
    assert.equal(
      audioStreams.length,
      1,
      `expected exactly one audio stream, got ${audioStreams.length}`,
    );
    const audioDuration = Number(audioStreams[0].duration);
    assert.ok(
      Number.isFinite(audioDuration) && audioDuration > 0,
      "audio stream should have positive duration (not silent)",
    );
    assert.ok(
      audioDuration <= duration + 0.5,
      `audio stream duration (${audioDuration}s) should not exceed container (${duration}s)`,
    );

    const allWarnings = [...(manifest.warnings ?? []), ...(entry.warnings ?? [])];
    assert.ok(!allWarnings.some((w) => w.code === "RENDER_FATAL"));
  });
});
