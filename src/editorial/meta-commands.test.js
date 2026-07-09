import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assignWordIds } from "../schemas/word-index.js";
import {
  extractMetaCommands,
  buildVoiceDirectivesFromMetaCommands,
} from "./meta-commands.js";

const scenes = [{
  sceneId: "clip01_scene001",
  clipId: "clip01",
  startSec: 0,
  endSec: 10,
}];

function wordsFromFixture(rawWords) {
  return assignWordIds(rawWords, "clip01");
}

describe("extractMetaCommands", () => {
  it("detects add_text_overlay with Polish date extraction", () => {
    const words = wordsFromFixture([
      { word: "Hej", start: 0.0, end: 0.3 },
      { word: "dodaj", start: 0.35, end: 0.7 },
      { word: "tu", start: 0.75, end: 0.9 },
      { word: "datę", start: 0.95, end: 1.3 },
      { word: "realizacji", start: 1.35, end: 2.0 },
      { word: "filmu", start: 2.05, end: 2.5 },
      { word: "czyli", start: 2.55, end: 2.9 },
      { word: "6", start: 2.95, end: 3.1 },
      { word: "lipca", start: 3.15, end: 3.6 },
      { word: "2020", start: 3.65, end: 4.2 },
    ]);

    const commands = extractMetaCommands(words, { scenes, clipId: "clip01" });

    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, "add_text_overlay");
    assert.equal(commands[0].extractedText, "6 lipca 2020");
    assert.equal(commands[0].sceneId, "clip01_scene001");
    assert.equal(commands[0].removeInstructionFromAudio, true);
    assert.match(commands[0].rawPhrase, /dodaj.*datę/i);
    assert.equal(commands[0].startWordId, words[1].wordId);
    assert.equal(commands[0].endWordId, words[9].wordId);
  });

  it("detects boomerang meta-command phrase", () => {
    const words = wordsFromFixture([
      { word: "Zrób", start: 0.0, end: 0.35 },
      { word: "tu", start: 0.4, end: 0.55 },
      { word: "boomerang", start: 0.6, end: 1.2 },
      { word: "na", start: 1.25, end: 1.4 },
      { word: "tym", start: 1.45, end: 1.65 },
      { word: "skoku", start: 1.7, end: 2.3 },
    ]);

    const commands = extractMetaCommands(words, { scenes, clipId: "clip01" });

    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, "boomerang");
    assert.equal(commands[0].anchorWordId, words[2].wordId);
    assert.match(commands[0].rawPhrase, /boomerang/i);
    assert.equal(commands[0].confidence, 0.9);
  });

  it("detects reverse commands (cofnij and odpalcie to wstecz)", () => {
    const words = wordsFromFixture([
      { word: "cofnij", start: 0.0, end: 0.4 },
      { word: "to", start: 0.5, end: 0.7 },
      { word: "odpalcie", start: 1.0, end: 1.4 },
      { word: "to", start: 1.45, end: 1.55 },
      { word: "wstecz", start: 1.6, end: 2.0 },
    ]);

    const commands = extractMetaCommands(words, { scenes, clipId: "clip01" });

    assert.equal(commands.length, 2);
    assert.equal(commands[0].type, "reverse");
    assert.equal(commands[1].type, "reverse");
    assert.equal(commands[1].rawPhrase, "odpalcie to wstecz");
  });

  it("returns empty array for speech without meta-commands", () => {
    const words = wordsFromFixture([
      { word: "hej", start: 0.0, end: 0.3 },
      { word: "co", start: 0.4, end: 0.5 },
      { word: "tam", start: 0.6, end: 0.9 },
    ]);

    assert.deepEqual(extractMetaCommands(words, { scenes, clipId: "clip01" }), []);
  });
});

describe("buildVoiceDirectivesFromMetaCommands", () => {
  it("flattens per-clip artifacts with clipId", () => {
    const directives = buildVoiceDirectivesFromMetaCommands([
      {
        clipId: "clip01",
        commands: [{
          commandId: "clip01_mc001",
          type: "boomerang",
          anchorWordId: "clip01_w00002",
          sceneId: "clip01_scene001",
        }],
      },
    ]);

    assert.equal(directives.length, 1);
    assert.equal(directives[0].clipId, "clip01");
    assert.equal(directives[0].type, "boomerang");
  });
});
