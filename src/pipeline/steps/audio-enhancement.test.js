import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runAudioEnhancementStep,
  materializeSourceVolumeDb,
  enhancedAudioPath,
  reconcileAudioEnhancementDecisions,
  clipOnlyUsedOnPreserveAmbient,
  rebuildEnhancementIndexFromDisk,
  loadAudioEnhancementIndex,
  resolveEnhancedAudioForWhisper,
  resolveWhisperMediaPath,
} from "./audio-enhancement.js";
import { EditRecipeV2Schema } from "../../schemas/edit-recipe-v2.js";
import { ARTIFACTS, readJson, writeJson } from "../work-paths.js";
import { runFfmpeg } from "../../lib/ffmpeg.js";

async function writeSilentSourceWav(filePath, durationSec = 0.5) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    "-acodec",
    "pcm_s16le",
    "-ac",
    "1",
    filePath,
  ], { label: "test tone wav" });
}

describe("audio-enhancement step", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-audio-enh-"));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("with recipe reject and no artifacts still enhance-alls for Whisper", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-enh-reject-all-"));
    const sourcePath = path.join(dir, "clip01.wav");
    await writeSilentSourceWav(sourcePath, 0.4);

    const recipe = EditRecipeV2Schema.parse({
      version: "2.5",
      batchId: "test",
      batchContext: {
        inputMode: "single_clip",
        requiredFormats: ["16:9"],
      },
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Test",
        timeline: [],
      }],
      audioEnhancementDecisions: [{
        candidateId: "enh_clip01",
        clipId: "clip01",
        action: "reject",
        dialogueValue: "dispensable",
        reason: "Dialog zbędny",
      }],
    });

    writeJson(path.join(dir, ARTIFACTS.recipeDraft), recipe);
    writeJson(path.join(dir, ARTIFACTS.sceneCatalog), {
      batchId: "test",
      clips: [{
        clipId: "clip01",
        sourcePath,
        fileName: "clip01.wav",
        durationSec: 0.4,
      }],
    });

    const index = await runAudioEnhancementStep({
      workDir: dir,
      force: true,
      config: { provider: "stub", stub: true, required: false },
    });

    assert.equal(index.clips.length, 1);
    assert.ok(["succeeded", "stubbed"].includes(index.clips[0].status));
    assert.ok(fs.existsSync(enhancedAudioPath(dir, "clip01")));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("materializeSourceVolumeDb clears sourceVolumeDb because gain is in enhanced WAV", () => {
    const recipe = EditRecipeV2Schema.parse({
      version: "2.5",
      batchId: "test",
      batchContext: {
        inputMode: "single_clip",
        requiredFormats: ["16:9"],
      },
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Test",
        timeline: [{
          segmentId: "seg01",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 5,
          audioInSec: 0,
          audioOutSec: 5,
          outputStartSec: 0,
          outputEndSec: 5,
          audioPolicy: "from_video_ref",
        }],
      }],
    });

    materializeSourceVolumeDb(recipe, {
      clips: [{
        clipId: "clip01",
        status: "succeeded",
        sourceVolumeDb: 4.5,
      }],
    });

    assert.equal(recipe.outputs[0].timeline[0].sourceVolumeDb, 0);
  });

  it("enhancedAudioPath resolves under work dir", () => {
    assert.ok(enhancedAudioPath(workDir, "clip01").endsWith("enhanced-audio/clip01.wav"));
  });

  it("reconcileAudioEnhancementDecisions flips reject to accept for succeeded clips", () => {
    const recipe = EditRecipeV2Schema.parse({
      version: "2.5",
      batchId: "test",
      batchContext: {
        inputMode: "single_clip",
        requiredFormats: ["16:9"],
      },
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Test",
        timeline: [],
      }],
      audioEnhancementDecisions: [{
        candidateId: "enh_clip16",
        clipId: "clip16",
        action: "reject",
        dialogueValue: "essential",
        reason: "brak udanego artefaktu audio_enhancement wymaga odrzucenia",
        providerPreference: "auto",
      }],
    });

    reconcileAudioEnhancementDecisions(recipe, {
      clips: [{
        candidateId: "enh_clip16",
        clipId: "clip16",
        status: "succeeded",
        provider: "dpdfnet",
        sourceVolumeDb: 12,
      }],
    }, {
      perClipAnalysis: [{
        clipId: "clip16",
        audioQuality: { humScore: 0.7, windScore: 0.2 },
      }],
    });

    assert.equal(recipe.audioEnhancementDecisions[0].action, "accept");
    assert.equal(recipe.audioEnhancementDecisions[0].polishPreset, "repair_only");
    assert.match(recipe.audioEnhancementDecisions[0].reason, /reconciled|Zgodne/);
  });

  it("does not overwrite enhancement index when accepted is empty but index has succeeded clips", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-enh-reuse-rej-"));
    const sourcePath = path.join(dir, "clip16.wav");
    await writeSilentSourceWav(sourcePath, 0.4);

    const recipe = EditRecipeV2Schema.parse({
      version: "2.5",
      batchId: "test",
      batchContext: {
        inputMode: "single_clip",
        requiredFormats: ["16:9"],
      },
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Test",
        timeline: [{
          segmentId: "seg01",
          segmentRole: "aroll",
          videoRef: { clipId: "clip16", sceneId: "clip16_scene001" },
          audioRef: { clipId: "clip16", sceneId: "clip16_scene001" },
          videoInSec: 0,
          videoOutSec: 5,
          audioInSec: 0,
          audioOutSec: 5,
          audioPolicy: "from_video_ref",
        }],
      }],
      audioEnhancementDecisions: [{
        candidateId: "enh_clip16",
        clipId: "clip16",
        action: "reject",
        dialogueValue: "essential",
        reason: "bez udanego artefaktu audio_enhancement",
        providerPreference: "auto",
      }],
    });

    const existingIndex = {
      version: "1.0",
      batchId: "test",
      clips: [{
        version: "1.0",
        candidateId: "enh_clip16",
        clipId: "clip16",
        status: "succeeded",
        provider: "dpdfnet",
        sourceVolumeDb: 12,
        outputPath: "enhanced-audio/clip16.wav",
      }],
    };

    writeJson(path.join(dir, ARTIFACTS.recipeDraft), recipe);
    writeJson(path.join(dir, ARTIFACTS.audioEnhancementIndex), existingIndex);
    writeJson(path.join(dir, ARTIFACTS.audioEnhancementManifest("clip16")), existingIndex.clips[0]);
    fs.mkdirSync(path.join(dir, "enhanced-audio"), { recursive: true });
    fs.copyFileSync(sourcePath, enhancedAudioPath(dir, "clip16"));
    writeJson(path.join(dir, ARTIFACTS.sceneCatalog), {
      batchId: "test",
      clips: [{
        clipId: "clip16",
        sourcePath,
        fileName: "clip16.wav",
        durationSec: 0.4,
      }],
    });

    const index = await runAudioEnhancementStep({
      workDir: dir,
      force: false,
      config: { provider: "stub", stub: true, required: false },
    });

    assert.equal(index.clips.length, 1);
    assert.equal(index.clips[0].clipId, "clip16");
    assert.equal(index.clips[0].status, "succeeded");

    const updatedRecipe = readJson(path.join(dir, ARTIFACTS.recipeDraft));
    assert.equal(updatedRecipe.audioEnhancementDecisions[0].action, "accept");
    assert.equal(updatedRecipe.outputs[0].timeline[0].sourceVolumeDb, 0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recipe accept metadata is used when re-enhancing a catalog clip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-enh-accept-meta-"));
    const sourcePath = path.join(dir, "clip_acc.wav");
    await writeSilentSourceWav(sourcePath, 0.4);

    const recipe = EditRecipeV2Schema.parse({
      version: "2.5",
      batchId: "accept-meta",
      batchContext: {
        inputMode: "single_clip",
        requiredFormats: ["16:9"],
      },
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Test",
        timeline: [{
          segmentId: "seg01",
          segmentRole: "aroll",
          videoRef: { clipId: "clip_acc", sceneId: "clip_acc_scene001" },
          audioRef: { clipId: "clip_acc", sceneId: "clip_acc_scene001" },
          videoInSec: 0,
          videoOutSec: 0.4,
          audioInSec: 0,
          audioOutSec: 0.4,
          audioPolicy: "from_video_ref",
        }],
      }],
      audioEnhancementDecisions: [{
        candidateId: "enh_clip_acc",
        clipId: "clip_acc",
        action: "accept",
        dialogueValue: "essential",
        reason: "Director accept with target LUFS",
        providerPreference: "auto",
        targetDialogueLufs: -18,
      }],
    });

    writeJson(path.join(dir, ARTIFACTS.recipeDraft), recipe);
    writeJson(path.join(dir, ARTIFACTS.sceneCatalog), {
      batchId: "accept-meta",
      clips: [{
        clipId: "clip_acc",
        sourcePath,
        fileName: "clip_acc.wav",
        durationSec: 0.4,
      }],
    });

    const index = await runAudioEnhancementStep({
      workDir: dir,
      force: true,
      config: { provider: "stub", stub: true, required: false },
    });

    assert.equal(index.clips.length, 1);
    assert.equal(index.clips[0].clipId, "clip_acc");
    assert.ok(["succeeded", "stubbed"].includes(index.clips[0].status));
    assert.ok(fs.existsSync(enhancedAudioPath(dir, "clip_acc")));

    const updatedRecipe = readJson(path.join(dir, ARTIFACTS.recipeDraft));
    assert.equal(updatedRecipe.audioEnhancementDecisions[0].action, "accept");
    assert.equal(updatedRecipe.outputs[0].timeline[0].sourceVolumeDb, 0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reconcileAudioEnhancementDecisions preserves intentional_ambient_preserve reject", () => {
    const recipe = EditRecipeV2Schema.parse({
      version: "2.5",
      batchId: "test",
      batchContext: {
        inputMode: "single_clip",
        requiredFormats: ["16:9"],
      },
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Test",
        timeline: [],
      }],
      audioEnhancementDecisions: [{
        candidateId: "enh_clip16",
        clipId: "clip16",
        action: "reject",
        dialogueValue: "useful",
        reason: "intentional_ambient_preserve",
        providerPreference: "auto",
      }],
    });

    reconcileAudioEnhancementDecisions(recipe, {
      clips: [{
        candidateId: "enh_clip16",
        clipId: "clip16",
        status: "succeeded",
        provider: "dpdfnet",
        sourceVolumeDb: 12,
      }],
    });

    assert.equal(recipe.audioEnhancementDecisions[0].action, "reject");
    assert.equal(recipe.audioEnhancementDecisions[0].reason, "intentional_ambient_preserve");
  });

  it("clipOnlyUsedOnPreserveAmbient is true only when all uses are preserved", () => {
    const recipe = {
      outputs: [{
        timeline: [
          {
            preserveAmbientAudio: true,
            audioRef: { clipId: "clip_a" },
            videoRef: { clipId: "clip_a" },
          },
          {
            preserveAmbientAudio: true,
            audioRef: { clipId: "clip_a" },
            videoRef: { clipId: "clip_a" },
          },
          {
            audioRef: { clipId: "clip_b" },
            videoRef: { clipId: "clip_b" },
          },
        ],
      }],
    };
    assert.equal(clipOnlyUsedOnPreserveAmbient(recipe, "clip_a"), true);
    assert.equal(clipOnlyUsedOnPreserveAmbient(recipe, "clip_b"), false);
    assert.equal(clipOnlyUsedOnPreserveAmbient(recipe, "clip_missing"), false);
  });

  it("materializeSourceVolumeDb skips preserveAmbientAudio segments", () => {
    const recipe = EditRecipeV2Schema.parse({
      version: "2.5",
      batchId: "test",
      batchContext: {
        inputMode: "single_clip",
        requiredFormats: ["16:9"],
      },
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Test",
        timeline: [
          {
            segmentId: "seg_preserve",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 5,
            audioInSec: 0,
            audioOutSec: 5,
            audioPolicy: "from_video_ref",
            preserveAmbientAudio: true,
            sourceVolumeDb: -9,
          },
          {
            segmentId: "seg_normal",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 5,
            videoOutSec: 10,
            audioInSec: 5,
            audioOutSec: 10,
            audioPolicy: "from_video_ref",
          },
        ],
      }],
    });

    materializeSourceVolumeDb(recipe, {
      clips: [{
        clipId: "clip01",
        status: "succeeded",
        sourceVolumeDb: 6,
      }],
    });

    assert.equal(recipe.outputs[0].timeline[0].sourceVolumeDb, -9);
    assert.equal(recipe.outputs[0].timeline[1].sourceVolumeDb, 0);
  });

  it("rebuildEnhancementIndexFromDisk rebuilds index from manifests and WAV files", () => {
    const orphanWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-audio-enh-orphan-"));
    const clipId = "clip32";
    const wavPath = enhancedAudioPath(orphanWorkDir, clipId);
    fs.mkdirSync(path.dirname(wavPath), { recursive: true });
    fs.writeFileSync(wavPath, "fake-wav");

    writeJson(path.join(orphanWorkDir, ARTIFACTS.audioEnhancementManifest(clipId)), {
      version: "1.0",
      candidateId: "enh_clip32",
      clipId,
      status: "succeeded",
      provider: "stub",
      sourceVolumeDb: 8,
      normalization: { targetLufs: -18, gainDb: 8 },
    });

    const index = rebuildEnhancementIndexFromDisk(orphanWorkDir, { batchId: "test" });
    assert.equal(index.clips.length, 1);
    assert.equal(index.clips[0].clipId, clipId);

    const loaded = loadAudioEnhancementIndex(orphanWorkDir, { batchId: "test" });
    assert.equal(loaded.clips[0].clipId, clipId);

    fs.rmSync(orphanWorkDir, { recursive: true, force: true });
  });

  it("enhance-all without recipe denoises every catalog clip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-enh-all-"));
    const sourcePath = path.join(dir, "clip_a.wav");
    await writeSilentSourceWav(sourcePath, 0.4);

    writeJson(path.join(dir, ARTIFACTS.sceneCatalog), {
      batchId: "enh-all",
      clips: [{
        clipId: "clip_a",
        sourcePath,
        fileName: "clip_a.wav",
        durationSec: 0.4,
      }],
    });

    const index = await runAudioEnhancementStep({
      workDir: dir,
      force: true,
      config: { provider: "stub", stub: true, required: false },
    });

    assert.equal(index.clips.length, 1);
    assert.equal(index.clips[0].clipId, "clip_a");
    assert.ok(["succeeded", "stubbed"].includes(index.clips[0].status));
    assert.ok(fs.existsSync(enhancedAudioPath(dir, "clip_a")));
    assert.ok(fs.existsSync(path.join(dir, ARTIFACTS.audioEnhancementManifest("clip_a"))));
    assert.equal(fs.existsSync(path.join(dir, ARTIFACTS.recipeDraft)), false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("idempotent re-run skips work when manifests and WAVs exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-enh-idem-"));
    const sourcePath = path.join(dir, "clip_b.wav");
    await writeSilentSourceWav(sourcePath, 0.4);

    writeJson(path.join(dir, ARTIFACTS.sceneCatalog), {
      batchId: "enh-idem",
      clips: [{
        clipId: "clip_b",
        sourcePath,
        fileName: "clip_b.wav",
        durationSec: 0.4,
      }],
    });

    const first = await runAudioEnhancementStep({
      workDir: dir,
      force: true,
      config: { provider: "stub", stub: true, required: false },
    });
    assert.equal(first.clips.length, 1);

    const wavPath = enhancedAudioPath(dir, "clip_b");
    const manifestPath = path.join(dir, ARTIFACTS.audioEnhancementManifest("clip_b"));
    const wavMtime = fs.statSync(wavPath).mtimeMs;
    const manifestMtime = fs.statSync(manifestPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await runAudioEnhancementStep({
      workDir: dir,
      force: false,
      config: { provider: "stub", stub: true, required: false },
    });

    assert.equal(second.clips.length, 1);
    assert.equal(second.clips[0].clipId, "clip_b");
    assert.equal(fs.statSync(wavPath).mtimeMs, wavMtime);
    assert.equal(fs.statSync(manifestPath).mtimeMs, manifestMtime);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveWhisperMediaPath prefers successful enhanced WAV", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-whisper-pref-"));
    const sourcePath = path.join(dir, "source.mov");
    const clip = { clipId: "clip_w", sourcePath };
    fs.writeFileSync(sourcePath, "fake");

    assert.equal(resolveWhisperMediaPath(dir, clip), sourcePath);
    assert.equal(resolveEnhancedAudioForWhisper(dir, "clip_w"), null);

    const wavPath = enhancedAudioPath(dir, "clip_w");
    fs.mkdirSync(path.dirname(wavPath), { recursive: true });
    fs.writeFileSync(wavPath, "enhanced");
    writeJson(path.join(dir, ARTIFACTS.audioEnhancementManifest("clip_w")), {
      version: "1.0",
      candidateId: "enh_clip_w",
      clipId: "clip_w",
      status: "succeeded",
      provider: "stub",
    });

    assert.equal(resolveEnhancedAudioForWhisper(dir, "clip_w"), wavPath);
    assert.equal(resolveWhisperMediaPath(dir, clip), wavPath);

    writeJson(path.join(dir, ARTIFACTS.audioEnhancementManifest("clip_w")), {
      version: "1.0",
      candidateId: "enh_clip_w",
      clipId: "clip_w",
      status: "failed",
      provider: "stub",
      warnings: ["boom"],
    });
    assert.equal(resolveWhisperMediaPath(dir, clip), sourcePath);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
