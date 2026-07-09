import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProfanityToken,
  censorWordForDisplay,
  isProfanityWord,
  tagProfanityWords,
  loadProfanityList,
} from "./profanity-censor.js";

describe("profanity-censor", () => {
  it("normalizeProfanityToken collapses 3+ repeated characters", () => {
    assert.equal(normalizeProfanityToken("kuuurwa"), "kurwa");
    assert.equal(normalizeProfanityToken("kuuuurwa"), "kurwa");
    assert.equal(normalizeProfanityToken("pierdooole"), "pierdole");
  });

  it("isProfanityWord matches normalized stems", () => {
    const list = loadProfanityList();
    assert.equal(isProfanityWord("kurwa", list), true);
    assert.equal(isProfanityWord("kuuurwa", list), true);
    assert.equal(isProfanityWord("restauracja", list), false);
  });

  it("censorWordForDisplay partial mode keeps first and last letter", () => {
    assert.equal(censorWordForDisplay("kurwa", "partial"), "k***a");
    assert.equal(censorWordForDisplay("chuj", "partial"), "c**j");
    assert.equal(censorWordForDisplay("ja", "partial"), "**");
  });

  it("censorWordForDisplay full mode masks entire word", () => {
    assert.equal(censorWordForDisplay("kurwa", "full"), "*****");
    assert.equal(censorWordForDisplay("ja", "full"), "**");
  });

  it("tagProfanityWords tags single words and multi-word phrases", () => {
    const words = [
      { word: "yyy", start: 0, end: 0.3 },
      { word: "ja", start: 0.3, end: 0.5 },
      { word: "pierdole", start: 0.5, end: 1.0 },
      { word: "tam", start: 1.0, end: 1.2 },
      { word: "kurwa", start: 1.2, end: 1.5 },
    ];

    const tagged = tagProfanityWords(words);
    assert.equal(tagged[1].isProfanity, true);
    assert.equal(tagged[2].isProfanity, true);
    assert.equal(tagged[3].isProfanity, false);
    assert.equal(tagged[4].isProfanity, true);
    assert.equal(tagged[4].displayWord, "k***a");
    assert.equal(tagged[0].isProfanity, false);
  });

  it("tagProfanityWords skips displayWord when subtitle mode is off", () => {
    const words = [{ word: "kurwa", start: 0, end: 0.5 }];
    const tagged = tagProfanityWords(words, { profanityPolicy: "off" });
    assert.equal(tagged[0].isProfanity, true);
    assert.equal(tagged[0].displayWord, undefined);
  });
});
