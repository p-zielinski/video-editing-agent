import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRecipeV2 } from "../../src/validators/recipe-v2.js";
import { EditRecipeV2Schema } from "../../src/schemas/edit-recipe-v2.js";
import { TopicIndexSchema } from "../../src/schemas/edit-recipe-v2.js";
import { SpatialIndexSchema } from "../../src/schemas/spatial-index.js";
import {
  DEFAULT_VLOG_RETENTION_PROFILE,
  enrichRecipeRetentionBeats,
} from "../../src/editorial/shorts-retention.js";

function resolveBatchDir(batchName) {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../fixtures/batches",
    batchName,
  );
}

function loadBatchJson(batchName, name) {
  return JSON.parse(fs.readFileSync(path.join(resolveBatchDir(batchName), name), "utf8"));
}

describe("golden recipe v2.4 (mini-day batch)", () => {
  const recipe = loadBatchJson("mini-day", "golden-recipe-v2.json");
  const topicIndex = TopicIndexSchema.parse(loadBatchJson("mini-day", "topic-index.json"));
  const spatialIndex = SpatialIndexSchema.parse(loadBatchJson("mini-day", "spatial-index.json"));

  it("golden-recipe-v2.json parses as EditRecipeV2", () => {
    const parsed = EditRecipeV2Schema.parse(recipe);
    assert.equal(parsed.version, "2.4");
    assert.equal(parsed.sfxPlan.length, 1);
    assert.equal(parsed.sfxPlan[0].sfxId, "whoosh");
    assert.equal(parsed.colorGrade.lutId, "warm_golden_hour");
    assert.ok(parsed.renderStylePresets?.formats?.["9:16"]?.safeZone);
    assert.ok(parsed.shortsRetentionProfile?.enabled);
  });

  it("passes validateRecipeV2 with batch topic and spatial indexes", () => {
    const result = validateRecipeV2(recipe, {
      topicIndex,
      spatialIndex,
      requiredFormats: recipe.batchContext.requiredFormats,
    });

    const errors = result.issues.filter((i) => i.severity === "error");
    assert.equal(
      result.valid,
      true,
      errors.map((e) => `${e.code}: ${e.message}`).join("\n"),
    );
  });

  it("includes retention hook and beats on short output", () => {
    const shortOutput = recipe.outputs.find((o) => o.outputKind === "short");
    assert.ok(shortOutput);
    const hooks = recipe.creativeMoments.filter((m) => m.retentionRole === "hook");
    const beats = recipe.creativeMoments.filter((m) => m.retentionRole === "beat");
    assert.ok(hooks.length >= 1);
    assert.ok(beats.length >= 2);
  });

  it("includes vlog retention beats on main output", () => {
    const mainBeats = recipe.creativeMoments.filter(
      (m) => m.outputId === "horizontal_main" && m.retentionRole === "beat",
    );
    assert.ok(mainBeats.length >= 2);
    assert.ok(mainBeats.some((m) => m.techniqueId === "zoom_slow_push"));
    assert.ok(mainBeats.some((m) => m.techniqueId === "ken_burns_light"));
    assert.ok(recipe.vlogRetentionProfile?.enabled);
  });

  it("enrichRecipeRetentionBeats adds enrich_beat_* on sparse long-main recipe", () => {
    const sparseRecipe = {
      outputs: [{
        outputId: "horizontal_main",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 300,
        timeline: [{ outputEndSec: 300, videoInSec: 0, videoOutSec: 300 }],
      }],
      vlogRetentionProfile: { ...DEFAULT_VLOG_RETENTION_PROFILE, enabled: true },
      creativeMoments: [],
    };
    const audioIndex = {
      clips: [{
        clipId: "clip01",
        energyPeaks: [{ startSec: 39, endSec: 41, rmsDb: -12 }],
      }],
    };

    const moments = enrichRecipeRetentionBeats(sparseRecipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });

    const enriched = moments.filter((m) => m.momentId.startsWith("enrich_beat_"));
    assert.ok(enriched.length >= 1);
    assert.equal(enriched[0].momentId, "enrich_beat_001");
    assert.equal(enriched[0].retentionRole, "beat");
  });
});

describe("golden recipe v2.4 (voiceover-day batch)", () => {
  const recipe = loadBatchJson("voiceover-day", "golden-recipe-v2.json");
  const wordIndexes = [
    loadBatchJson("voiceover-day", "01-words-clip01.json"),
    loadBatchJson("voiceover-day", "01-words-clip02.json"),
    loadBatchJson("voiceover-day", "01-words-clip03.json"),
  ];

  it("golden-recipe-v2.json parses as EditRecipeV2", () => {
    const parsed = EditRecipeV2Schema.parse(recipe);
    assert.equal(parsed.version, "2.4");
    assert.equal(parsed.batchId, "voiceoverday");

    const narration = parsed.clipRegistry.find((c) => c.clipId === "clip03");
    assert.equal(narration?.clipRole, "narration_track");
    assert.equal(narration?.mediaType, "audio_only");
    assert.equal(narration?.hasSpeech, true);
  });

  it("uses from_audio_ref on broll segments with separate narration clip", () => {
    const main = recipe.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(main);
    assert.equal(main.timeline.length, 2);

    for (const segment of main.timeline) {
      assert.equal(segment.segmentRole, "broll");
      assert.equal(segment.audioPolicy, "from_audio_ref");
      assert.equal(segment.audioRef.clipId, "clip03");
      assert.notEqual(segment.videoRef.clipId, segment.audioRef.clipId);
      assert.equal(segment.subtitles?.sourceClipId, "clip03");
    }
  });

  it("passes validateRecipeV2 with narration word indexes", () => {
    const result = validateRecipeV2(recipe, {
      wordIndexes,
      requiredFormats: recipe.batchContext.requiredFormats,
    });

    const errors = result.issues.filter((i) => i.severity === "error");
    assert.equal(
      result.valid,
      true,
      errors.map((e) => `${e.code}: ${e.message}`).join("\n"),
    );
  });
});
