import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProfanityToken,
  censorWordForDisplay,
  isProfanityWord,
  resolveAmbiguousSafetyContexts,
  sanitizeTextForSafety,
  tagContentSafetyWords,
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
    assert.equal(tagged[1].isProfanity, false);
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

  it("matches common Polish profanity inflections through bounded roots", () => {
    const tagged = tagContentSafetyWords([
      { word: "kurwie", start: 0, end: 0.2 },
      { word: "pierdolą", start: 0.2, end: 0.4 },
      { word: "jebani", start: 0.4, end: 0.6 },
    ]);

    assert.equal(tagged.every((word) => word.isProfanity), true);
    assert.equal(tagged.every((word) => word.safetyClass === "profanity"), true);
  });

  it("allows neutral protected identity references", () => {
    const tagged = tagContentSafetyWords([
      { word: "Jestem", start: 0, end: 0.2 },
      { word: "Żydem", start: 0.2, end: 0.5 },
    ]);

    assert.equal(tagged[1].safetyClass, "protected_identity");
    assert.equal(tagged[1].safetyAction, "allow");
    assert.equal(tagged[1].displayWord, undefined);
  });

  it("flags a protected identity when used in a direct hateful attack", () => {
    const tagged = tagContentSafetyWords([
      { word: "Nienawidzę", start: 0, end: 0.3 },
      { word: "Żydów", start: 0.3, end: 0.6 },
    ]);

    assert.equal(tagged[1].safetyClass, "hateful_attack");
    assert.equal(tagged[1].safetyAction, "bleep");
    assert.ok(tagged[1].displayWord);
  });

  it("marks sensitive crime terms for contextual review", () => {
    const tagged = tagContentSafetyWords([
      { word: "morderca", start: 0, end: 0.4 },
      { word: "pedofil", start: 0.4, end: 0.8 },
    ]);

    assert.equal(tagged[0].safetyClass, "sensitive");
    assert.equal(tagged[0].safetyAction, "review");
    assert.equal(tagged[1].safetyAction, "review");
  });

  it("accepts validated classifier decisions only for ambiguous candidates", async () => {
    const words = tagContentSafetyWords([
      { word: "Dokument", start: 0, end: 0.2 },
      { word: "opowiada", start: 0.2, end: 0.4 },
      { word: "o", start: 0.4, end: 0.5 },
      { word: "mordercy", start: 0.5, end: 0.8 },
    ]);
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  decisions: [{
                    candidateId: "safety_3",
                    action: "allow",
                    reason: "documentary_context",
                    confidence: 0.95,
                  }],
                }),
              },
            }],
          }),
        },
      },
    };

    const resolved = await resolveAmbiguousSafetyContexts(words, { client });

    assert.equal(resolved[3].safetyAction, "allow");
    assert.equal(resolved[3].safetyReason, "documentary_context");
    assert.equal(resolved[3].safetyConfidence, 0.95);
  });

  it("falls back conservatively when ambiguous classification is unavailable", async () => {
    const words = tagContentSafetyWords([
      { word: "pedofil", start: 0, end: 0.5 },
      { word: "Żyd", start: 0.5, end: 0.8 },
    ]);

    const resolved = await resolveAmbiguousSafetyContexts(words);

    assert.equal(resolved[0].safetyAction, "bleep");
    assert.equal(resolved[0].safetyReason, "classifier_fallback");
    assert.equal(resolved[1].safetyAction, "allow");
  });

  it("sanitizes unsafe generated text while preserving neutral identities", () => {
    assert.equal(
      sanitizeTextForSafety("Żyd opowiada swoją historię"),
      "Żyd opowiada swoją historię",
    );
    assert.equal(
      sanitizeTextForSafety("Morderca uciekł z miejsca"),
      "m******a uciekł z miejsca",
    );
    assert.equal(
      sanitizeTextForSafety("To jest kurwa skandal"),
      "To jest k***a skandal",
    );
  });

  it("preserves sensitive terms in clear documentary context", () => {
    assert.equal(
      sanitizeTextForSafety("Dokument opowiada o mordercy"),
      "Dokument opowiada o mordercy",
    );
  });
});
