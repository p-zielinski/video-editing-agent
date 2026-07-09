import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichRecipeProfanity } from "../../src/editorial/profanity-enrich.js";

const wordIndexes = [{
  clipId: "clip01",
  words: [
    { wordId: "clip01_w001", word: "hej", start: 0.5, end: 0.8, isProfanity: false },
    { wordId: "clip01_w002", word: "kurwa", start: 1.0, end: 1.4, isProfanity: true },
    { wordId: "clip01_w003", word: "serio", start: 1.5, end: 1.9, isProfanity: false },
    { wordId: "clip01_w004", word: "pierdole", start: 2.0, end: 2.5, isProfanity: true },
  ],
}];

function baseRecipe() {
  return {
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      timeline: [{
        segmentId: "s1",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 10,
        audioInSec: 0,
        audioOutSec: 10,
        audioPolicy: "from_video_ref",
        outputStartSec: 0,
        outputEndSec: 10,
        cuts: [],
        audioCensorship: [],
      }],
    }],
  };
}

describe("enrichRecipeProfanity", () => {
  it("adds bleep windows by default for profane words", () => {
    const recipe = baseRecipe();
    const applied = enrichRecipeProfanity(recipe, wordIndexes, {});

    assert.equal(applied, 2);
    assert.equal(recipe.outputs[0].timeline[0].audioCensorship.length, 2);
    assert.deepEqual(recipe.outputs[0].timeline[0].audioCensorship[0], {
      startSec: 1.0,
      endSec: 1.4,
      mode: "bleep",
      wordId: "clip01_w002",
    });
  });

  it("adds profanity cuts when policy is cut", () => {
    const recipe = baseRecipe();
    const applied = enrichRecipeProfanity(recipe, wordIndexes, { profanityPolicy: "cut" });

    assert.equal(applied, 2);
    assert.deepEqual(recipe.outputs[0].timeline[0].cuts, [
      { startWordId: "clip01_w002", endWordId: "clip01_w002", reason: "profanity" },
      { startWordId: "clip01_w004", endWordId: "clip01_w004", reason: "profanity" },
    ]);
    assert.equal(recipe.outputs[0].timeline[0].audioCensorship.length, 0);
  });

  it("adds mute windows when policy is mute", () => {
    const recipe = baseRecipe();
    enrichRecipeProfanity(recipe, wordIndexes, { profanityPolicy: "mute" });

    assert.ok(recipe.outputs[0].timeline[0].audioCensorship.every((w) => w.mode === "mute"));
  });

  it("is a no-op when policy is off", () => {
    const recipe = baseRecipe();
    const applied = enrichRecipeProfanity(recipe, wordIndexes, { profanityPolicy: "off" });
    assert.equal(applied, 0);
    assert.equal(recipe.outputs[0].timeline[0].audioCensorship.length, 0);
  });

  it("is idempotent when bleep windows already exist", () => {
    const recipe = baseRecipe();
    enrichRecipeProfanity(recipe, wordIndexes, {});
    const applied = enrichRecipeProfanity(recipe, wordIndexes, {});
    assert.equal(applied, 0);
    assert.equal(recipe.outputs[0].timeline[0].audioCensorship.length, 2);
  });

  it("adds audioCensorship to short output when profanity present", () => {
    const recipe = {
      outputs: [
        ...baseRecipe().outputs,
        {
          outputId: "short_9x16",
          outputKind: "short",
          format: "9:16",
          timeline: [{
            segmentId: "s1",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 10,
            audioInSec: 0,
            audioOutSec: 10,
            audioPolicy: "from_video_ref",
            outputStartSec: 0,
            outputEndSec: 10,
            cuts: [],
            audioCensorship: [],
          }],
        },
      ],
    };

    enrichRecipeProfanity(recipe, wordIndexes, {});

    const shortOutput = recipe.outputs.find((output) => output.outputKind === "short");
    assert.equal(shortOutput.timeline[0].audioCensorship.length, 2);
    assert.deepEqual(shortOutput.timeline[0].audioCensorship[0], {
      startSec: 1.0,
      endSec: 1.4,
      mode: "bleep",
      wordId: "clip01_w002",
    });
  });
});
