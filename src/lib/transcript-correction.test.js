import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyExpectedTermCorrections,
  buildVariantMap,
  polishMishearVariants,
} from "./transcript-correction.js";
import { isProfanityWord, tagProfanityWords } from "./profanity-censor.js";

describe("transcript-correction", () => {
  it("polishMishearVariants generates benchmark mishears", () => {
    assert.ok(polishMishearVariants("elden").has("eldyn"));
    assert.ok(polishMishearVariants("breaking").has("brejking"));
  });

  it("buildVariantMap maps mishears to canonical spelling", () => {
    const map = buildVariantMap(["Elden Ring", "Breaking Bad"]);
    assert.equal(map.get("eldyn"), "Elden");
    assert.equal(map.get("brejking"), "Breaking");
    assert.equal(map.get("bad"), undefined);
  });

  it("applyExpectedTermCorrections fixes Polish phonetic variants", () => {
    const words = [
      { word: "Gram", start: 0, end: 0.3 },
      { word: "w", start: 0.3, end: 0.4 },
      { word: "eldyn", start: 0.4, end: 0.8 },
      { word: "ring", start: 0.8, end: 1.1 },
    ];

    const corrected = applyExpectedTermCorrections(words, ["Elden Ring"]);
    assert.equal(corrected[2].word, "Elden");
    assert.equal(corrected[2].normalizedWord, "elden");
    assert.equal(corrected[3].word, "ring");
  });

  it("applyExpectedTermCorrections leaves already-correct tokens unchanged", () => {
    const words = [{ word: "Breaking", start: 0, end: 0.5 }];
    const corrected = applyExpectedTermCorrections(words, ["Breaking Bad"]);
    assert.equal(corrected[0].word, "Breaking");
    assert.equal(corrected[0].normalizedWord, "breaking");
  });

  it("applyExpectedTermCorrections preserves profanity tags from upstream", () => {
    const words = tagProfanityWords([{ word: "kuuurwa", start: 0, end: 0.5 }]);
    const corrected = applyExpectedTermCorrections(words, []);
    assert.equal(corrected[0].isProfanity, true);
    assert.equal(corrected[0].displayWord, "k***a");
    assert.equal(corrected[0].normalizedWord, "kurwa");
  });

  it("applyExpectedTermCorrections is a no-op without expectedTerms", () => {
    const words = [{ word: "eldyn", start: 0, end: 0.5 }];
    const corrected = applyExpectedTermCorrections(words, []);
    assert.equal(corrected[0].word, "eldyn");
    assert.equal(corrected[0].normalizedWord, "eldyn");
    assert.equal(corrected[0].isProfanity, undefined);
  });

  it("isProfanityWord recognizes common Polish profanity stems", () => {
    assert.equal(isProfanityWord("kurwa"), true);
    assert.equal(isProfanityWord("pierdole"), true);
    assert.equal(isProfanityWord("restauracja"), false);
  });
});
