import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runAudioEnhancementStep,
  materializeSourceVolumeDb,
  enhancedAudioPath,
} from "./audio-enhancement.js";
import { EditRecipeV2Schema } from "../../schemas/edit-recipe-v2.js";
import { ARTIFACTS, writeJson } from "../work-paths.js";

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
});
