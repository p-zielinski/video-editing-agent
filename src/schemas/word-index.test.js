import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assignWordIds, WordEntrySchema, WordIndexSchema } from "./word-index.js";

describe("word-index", () => {
  it("assignWordIds passes through normalizedWord, isProfanity, and displayWord", () => {
    const words = [
      {
        word: "elden",
        start: 0,
        end: 0.5,
        normalizedWord: "elden",
        isProfanity: false,
      },
      {
        word: "kurwa",
        start: 0.5,
        end: 1,
        normalizedWord: "kurwa",
        isProfanity: true,
        displayWord: "k***a",
        safetyClass: "profanity",
        safetyAction: "bleep",
        safetyReason: "profanity_match",
        safetyConfidence: 1,
      },
    ];

    const withIds = assignWordIds(words, "clip1");
    assert.equal(withIds[0].normalizedWord, "elden");
    assert.equal(withIds[0].isProfanity, false);
    assert.equal(withIds[1].normalizedWord, "kurwa");
    assert.equal(withIds[1].isProfanity, true);
    assert.equal(withIds[1].displayWord, "k***a");
    assert.equal(withIds[1].safetyClass, "profanity");
    assert.equal(withIds[1].safetyAction, "bleep");
    assert.doesNotThrow(() => WordIndexSchema.parse({
      version: "1.0",
      clipId: "clip1",
      words: withIds,
      durationSec: 1,
    }));
  });

  it("WordEntrySchema accepts optional normalizedWord and isProfanity", () => {
    assert.doesNotThrow(() => WordEntrySchema.parse({
      wordId: "c_w00000",
      word: "test",
      start: 0,
      end: 0.5,
      normalizedWord: "test",
      isProfanity: false,
    }));
  });
});
