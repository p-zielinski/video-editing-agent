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
} from "./audio-enhancement.js";
import { EditRecipeV2Schema } from "../../schemas/edit-recipe-v2.js";
import { ARTIFACTS, readJson, writeJson } from "../work-paths.js";

describe("audio-enhancement step", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-audio-enh-"));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("skips enhancement when no accept decisions", async () => {
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

    writeJson(path.join(workDir, ARTIFACTS.recipeDraft), recipe);
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      batchId: "test",
      clips: [{
        clipId: "clip01",
        sourcePath: path.join(workDir, "fake.mov"),
        fileName: "fake.mov",
        durationSec: 10,
      }],
    });

    const index = await runAudioEnhancementStep({
      workDir,
      force: true,
      config: { provider: "stub", stub: true, required: false },
    });

    assert.equal(index.clips.length, 0);
  });

  it("materializeSourceVolumeDb updates segments for enhanced clip", () => {
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

    assert.equal(recipe.outputs[0].timeline[0].sourceVolumeDb, 4.5);
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
      }],
    };

    writeJson(path.join(workDir, ARTIFACTS.recipeDraft), recipe);
    writeJson(path.join(workDir, ARTIFACTS.audioEnhancementIndex), existingIndex);
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      batchId: "test",
      clips: [{
        clipId: "clip16",
        sourcePath: path.join(workDir, "fake.mov"),
        fileName: "fake.mov",
        durationSec: 10,
      }],
    });

    const index = await runAudioEnhancementStep({
      workDir,
      force: true,
      config: { provider: "stub", stub: true, required: false },
    });

    assert.equal(index.clips.length, 1);
    assert.equal(index.clips[0].clipId, "clip16");
    assert.equal(index.clips[0].status, "succeeded");

    const updatedRecipe = readJson(path.join(workDir, ARTIFACTS.recipeDraft));
    assert.equal(updatedRecipe.audioEnhancementDecisions[0].action, "accept");
    assert.equal(updatedRecipe.outputs[0].timeline[0].sourceVolumeDb, 12);
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

    assert.equal(recipe.outputs[0].timeline[0].sourceVolumeDb ?? 0, 0);
    assert.equal(recipe.outputs[0].timeline[1].sourceVolumeDb, 6);
  });
});
