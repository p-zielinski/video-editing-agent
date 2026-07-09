import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichRecipeVoiceDirectives } from "./voice-directive-enrich.js";

const timelineIndex = {
  scenes: [{
    sceneId: "clip01_scene001",
    clipId: "clip01",
    startSec: 0,
    endSec: 10,
  }],
  words: [
    { wordId: "clip01_w00001", word: "dodaj", start: 0.35, end: 0.7 },
    { wordId: "clip01_w00009", word: "2020", start: 3.65, end: 4.2 },
    { wordId: "clip01_w00002", word: "boomerang", start: 0.6, end: 1.2 },
  ],
};

const metaCommandsByClip = [{
  clipId: "clip01",
  commands: [
    {
      commandId: "clip01_mc001",
      type: "add_text_overlay",
      anchorWordId: "clip01_w00001",
      startWordId: "clip01_w00001",
      endWordId: "clip01_w00009",
      sceneId: "clip01_scene001",
      extractedText: "6 lipca 2020",
      removeInstructionFromAudio: true,
      confidence: 0.92,
      rawPhrase: "dodaj tu datę 6 lipca 2020",
    },
    {
      commandId: "clip01_mc002",
      type: "boomerang",
      anchorWordId: "clip01_w00002",
      startWordId: "clip01_w00000",
      endWordId: "clip01_w00005",
      sceneId: "clip01_scene001",
      removeInstructionFromAudio: true,
      confidence: 0.9,
      rawPhrase: "zrób tu boomerang na tym skoku",
    },
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
        cuts: [],
        textOverlays: [],
      }],
    }],
  };
}

describe("enrichRecipeVoiceDirectives", () => {
  it("materializes text overlays and voice directive cuts", () => {
    const recipe = baseRecipe();
    const applied = enrichRecipeVoiceDirectives(recipe, metaCommandsByClip, timelineIndex);

    assert.ok(applied >= 3);
    const segment = recipe.outputs[0].timeline[0];
    assert.equal(segment.cuts.length, 2);
    assert.equal(segment.cuts[0].reason, "voice_directive");
    assert.equal(segment.textOverlays.length, 1);
    assert.equal(segment.textOverlays[0].text, "6 lipca 2020");
    assert.equal(segment.textOverlays[0].overlayId, "voice_clip01_mc001");
  });

  it("sets boomerang playbackMode on matching segment", () => {
    const recipe = baseRecipe();
    enrichRecipeVoiceDirectives(recipe, metaCommandsByClip, timelineIndex);

    const segment = recipe.outputs[0].timeline[0];
    assert.equal(segment.videoTransform.playbackMode, "boomerang");
    assert.equal(segment.videoTransform.boomerangHalfSec, 2.0);
    assert.equal(segment.audioPolicy, "mute");
  });

  it("sets reverse playbackMode on matching segment", () => {
    const recipe = baseRecipe();
    const commands = [{
      clipId: "clip01",
      commands: [{
        commandId: "clip01_mc003",
        type: "reverse",
        anchorWordId: "clip01_w00002",
        startWordId: "clip01_w00000",
        endWordId: "clip01_w00005",
        sceneId: "clip01_scene001",
        removeInstructionFromAudio: true,
        confidence: 0.9,
        rawPhrase: "odwróć to",
      }],
    }];

    enrichRecipeVoiceDirectives(recipe, commands, timelineIndex);

    const segment = recipe.outputs[0].timeline[0];
    assert.equal(segment.videoTransform.playbackMode, "reverse");
    assert.equal(segment.audioPolicy, "mute");
    assert.equal(segment.videoTransform.boomerangHalfSec, undefined);
  });

  it("skips instruction cuts when removeInstructionFromAudio is false", () => {
    const recipe = baseRecipe();
    const commands = [{
      clipId: "clip01",
      commands: [{
        ...metaCommandsByClip[0].commands[0],
        removeInstructionFromAudio: false,
      }],
    }];

    enrichRecipeVoiceDirectives(recipe, commands, timelineIndex);

    const segment = recipe.outputs[0].timeline[0];
    assert.equal(segment.cuts.length, 0);
    assert.equal(segment.textOverlays.length, 1);
  });

  it("is a no-op without commands", () => {
    const recipe = baseRecipe();
    const applied = enrichRecipeVoiceDirectives(recipe, [], timelineIndex);
    assert.equal(applied, 0);
  });
});
