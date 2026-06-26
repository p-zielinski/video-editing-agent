import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PUBLISH_VOICE,
  applyPublishVoiceToVariant,
  formatDescriptionForVoice,
  formatTitleForVoice,
  mergePublishVoice,
  resolvePublishVoice,
} from "./publish-voice.js";

describe("publish-voice", () => {
  it("defaults to loud thumbnails and quiet lowercase descriptions", () => {
    assert.equal(DEFAULT_PUBLISH_VOICE.thumbnailVoice, "loud");
    assert.equal(DEFAULT_PUBLISH_VOICE.descriptionVoice, "lowercase_casual");
    assert.equal(DEFAULT_PUBLISH_VOICE.descriptionRules.allLowercase, true);
  });

  it("lowercases and strips shouty punctuation from descriptions", () => {
    const result = formatDescriptionForVoice(
      "Dzień 66! Co się stało? Sprawdź sam.",
      DEFAULT_PUBLISH_VOICE,
    );

    assert.equal(result, "dzień 66 co się stało sprawdź sam.");
    assert.ok(!result.includes("!"));
    assert.ok(!result.includes("?"));
  });

  it("limits description to maxSentences", () => {
    const voice = mergePublishVoice({
      descriptionRules: { maxSentences: 1 },
    });
    const result = formatDescriptionForVoice(
      "pierwsze zdanie. drugie zdanie. trzecie zdanie.",
      voice,
    );

    assert.equal(result, "pierwsze zdanie.");
  });

  it("lowercases titleVariant for lowercase_casual profile", () => {
    const result = formatTitleForVoice("Ten Dzień Zmienił Wszystko!", DEFAULT_PUBLISH_VOICE);
    assert.equal(result, "ten dzień zmienił wszystko");
  });

  it("resolves publishVoice from userContext JSON override", () => {
    const voice = resolvePublishVoice({
      userContext: JSON.stringify({
        publishVoice: {
          titleVoice: "loud",
          descriptionVoice: "marketing",
        },
      }),
    });

    assert.equal(voice.titleVoice, "loud");
    assert.equal(voice.descriptionVoice, "marketing");
    assert.equal(voice.thumbnailVoice, "loud");
  });

  it("applyPublishVoiceToVariant leaves headline unchanged", () => {
    const variant = applyPublishVoiceToVariant({
      headline: "WIELKI HOOK",
      titleVariant: "WIELKI TYTUŁ!",
      descriptionVariant: "Opis Z Wykrzyknikiem!",
    });

    assert.equal(variant.headline, "WIELKI HOOK");
    assert.equal(variant.titleVariant, "wielki tytuł");
    assert.equal(variant.descriptionVariant, "opis z wykrzyknikiem");
  });
});
