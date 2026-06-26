import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isFillerWord,
  filterFillerWords,
  wordCore,
  cleanWhisperWords,
  tagFillerWords,
} from "../lib/srt-processor.js";

describe("filler detection", () => {
  it("detects polish filler words", () => {
    assert.equal(isFillerWord("yyy"), true);
    assert.equal(isFillerWord("um"), true);
    assert.equal(isFillerWord("cześć"), false);
    assert.equal(wordCore("  Yyy! "), "yyy");
  });

  it("filters filler words from list", () => {
    const words = [
      { word: "no", start: 0, end: 0.5 },
      { word: "yyy", start: 0.5, end: 1 },
      { word: "więc", start: 1, end: 1.5 },
    ];
    const filtered = filterFillerWords(words);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].word, "no");
    assert.equal(filtered[1].word, "więc");
  });

  it("tags fillers then cleans hallucination prefix", () => {
    const words = [
      { word: "yyy", start: 0, end: 0.4 },
      { word: "yyy", start: 0.5, end: 0.9 },
      { word: "cześć", start: 1, end: 1.4 },
      { word: "świecie", start: 1.5, end: 2 },
    ];

    const tagged = tagFillerWords(words);
    assert.equal(tagged.filter((w) => w.isFiller).length, 2);

    const cleaned = cleanWhisperWords(tagged);
    assert.ok(cleaned.length >= 2);
    assert.equal(cleaned.some((w) => w.word === "cześć"), true);
  });
});
