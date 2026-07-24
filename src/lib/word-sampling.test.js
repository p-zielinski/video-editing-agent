import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sampleWordsAcrossScene } from "./word-sampling.js";
import { DIRECTOR_BRIEF_CAPS } from "../editorial/brief-caps.js";

function makeWords(count, { startSec = 0, wordsPerSec = 2 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    wordId: `w${i}`,
    word: `word${i}`,
    start: startSec + i / wordsPerSec,
    end: startSec + (i + 1) / wordsPerSec,
    isFiller: false,
  }));
}

describe("sampleWordsAcrossScene", () => {
  it("returns all words when under cap", () => {
    const words = makeWords(30);
    const sampled = sampleWordsAcrossScene(words, 40);
    assert.equal(sampled.length, 30);
    assert.deepEqual(sampled, words);
  });

  it("uses head slice when moderately over cap", () => {
    const words = makeWords(70);
    const sampled = sampleWordsAcrossScene(words, 40);
    assert.equal(sampled.length, 40);
    assert.equal(sampled[0].word, "word0");
    assert.equal(sampled.at(-1).word, "word39");
  });

  it("samples beginning, middle, and end for long monologue scenes", () => {
    const words = makeWords(800, { startSec: 0, wordsPerSec: 1 });
    const maxWords = 40;
    const sampled = sampleWordsAcrossScene(words, maxWords);

    assert.ok(sampled.length > maxWords, "distributed budget exceeds per-scene cap");
    assert.ok(sampled.length <= Math.round(maxWords * DIRECTOR_BRIEF_CAPS.longSceneSampleBudgetMultiplier));

    const firstIdx = words.findIndex((w) => w.wordId === sampled[0].wordId);
    const lastSampledIdx = words.findIndex((w) => w.wordId === sampled.at(-1).wordId);
    assert.equal(firstIdx, 0);
    assert.ok(lastSampledIdx > words.length * 0.5, "should include late-scene words");

    const midAnchor = words[Math.floor(words.length / 2)];
    assert.ok(
      sampled.some((w) => Math.abs(w.start - midAnchor.start) < 30),
      "should include middle-of-scene words",
    );
  });

  it("preserves chronological order", () => {
    const words = makeWords(500, { startSec: 10, wordsPerSec: 1 });
    const sampled = sampleWordsAcrossScene(words, 40);
    for (let i = 1; i < sampled.length; i += 1) {
      assert.ok(sampled[i].start >= sampled[i - 1].start);
    }
  });
});
