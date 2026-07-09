import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getEffectiveSfxTags,
  isProfanityBleepCandidate,
  pickBestSfxByTagFromSounds,
  suggestSfxVolumeDb,
  summarizeSfxForDirector,
} from "./sfx-catalog-summary.js";
import {
  isSfxFileAvailable,
  listSfxCatalog,
  resolveProfanityBleepSfx,
  resolveSfxByTag,
} from "./sfx-library.js";

describe("sfx-catalog-summary", () => {
  it("infers bleep tag from censor title", () => {
    const tags = getEffectiveSfxTags({ title: "Censor Beep", tags: ["alert"] });
    assert.ok(tags.includes("bleep"));
    assert.ok(tags.includes("alert"));
  });

  it("infers notification tag from title", () => {
    const tags = getEffectiveSfxTags({ title: "New Notification - 3", tags: ["cat"] });
    assert.ok(tags.includes("notification"));
  });

  it("suggestSfxVolumeDb lowers volume for loud SFX", () => {
    const loud = suggestSfxVolumeDb({ integratedLufs: -6 });
    const quiet = suggestSfxVolumeDb({ integratedLufs: -20 });
    assert.ok(loud < quiet);
  });

  it("pickBestSfxByTagFromSounds prefers censor beep for bleep tag", () => {
    const sounds = [
      { sfxId: "a", title: "Beep", tags: ["alert"], durationSec: 1.5, integratedLufs: -6 },
      { sfxId: "b", title: "Censor Beep", tags: ["alert"], durationSec: 0.55 },
    ];
    const best = pickBestSfxByTagFromSounds(sounds, "bleep");
    assert.equal(best.sfxId, "b");
  });

  it("summarizeSfxForDirector exposes loudness and title", () => {
    const summary = summarizeSfxForDirector([
      { sfxId: "x", title: "Whoosh", tags: ["transition"], durationSec: 1, integratedLufs: -12 },
    ]);
    assert.equal(summary[0].title, "Whoosh");
    assert.equal(summary[0].integratedLufs, -12);
    assert.ok(typeof summary[0].suggestedVolumeDb === "number");
  });

  it("isProfanityBleepCandidate marks censor sounds", () => {
    assert.equal(isProfanityBleepCandidate({ title: "Censor Beep", sfxId: "x" }), true);
    assert.equal(isProfanityBleepCandidate({ title: "Whoosh", tags: ["whoosh"], sfxId: "y" }), false);
  });
});

describe("resolveProfanityBleepSfx (integration)", () => {
  it("resolves a real censor beep from assets catalog", () => {
    const { sound, reason } = resolveProfanityBleepSfx();
    assert.equal(reason, null);
    assert.ok(sound);
    assert.ok(isProfanityBleepCandidate(sound));
    assert.ok(isSfxFileAvailable(sound));
  });

  it("resolveSfxByTag(bleep) returns censor not generic long beep", () => {
    const { sound } = resolveSfxByTag("bleep");
    assert.ok(sound);
    const title = String(sound.title ?? "").toLowerCase();
    assert.ok(/censor|bleep/.test(title));
  });

  it("director summary includes available catalog sounds with LUFS when measured", () => {
    const available = listSfxCatalog().filter((s) => isSfxFileAvailable(s));
    const summary = summarizeSfxForDirector(available);
    assert.ok(summary.length > 0);
    const withLufs = summary.filter((s) => s.integratedLufs != null);
    assert.ok(withLufs.length > 0, "expected at least one SFX with integratedLufs in catalog");
    assert.ok(summary.every((s) => s.title && Array.isArray(s.tags)));
  });
});
