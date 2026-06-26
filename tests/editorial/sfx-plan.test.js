import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSfxPlanFromAudio } from "../../src/editorial/sfx-plan.js";
import { SfxPlanEntrySchema } from "../../src/schemas/edit-recipe-v2.js";

describe("sfx-plan", () => {
  it("returns empty plan for missing audio index", () => {
    assert.deepEqual(buildSfxPlanFromAudio(null), []);
    assert.deepEqual(buildSfxPlanFromAudio({ clips: [] }), []);
  });

  it("maps audioEvents to audio_event sfx entries", () => {
    const audioIndex = {
      clips: [{ clipId: "clip01", editorialTags: ["laughter"] }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      audioEvents: [
        { startSec: 8.5, endSec: 9.1, label: "Laughter", score: 0.74 },
        { startSec: 1.2, endSec: 2.0, label: "Speech", score: 0.88 },
        { startSec: 22.0, endSec: 22.4, label: "Squeak", score: 0.61 },
      ],
      editorialTags: [
        { tag: "laughter", peakScore: 0.74, count: 1, totalDurationSec: 0.6 },
      ],
    }];

    const plan = buildSfxPlanFromAudio(audioIndex, { perClipAnalysis, maxEntries: 10 });

    assert.ok(plan.length >= 2);
    const laughter = plan.find((entry) => entry.label === "laughter");
    const squeak = plan.find((entry) => entry.label === "squeak");
    assert.ok(laughter);
    assert.equal(laughter.source, "audio_event");
    assert.equal(laughter.clipId, "clip01");
    assert.equal(laughter.anchorTimeSec, 8.5);
    assert.equal(laughter.volumeDb, -6);
    assert.ok(squeak);
    assert.equal(squeak.source, "audio_event");
    assert.ok(!plan.some((entry) => entry.label === "speech"));
  });

  it("falls back to library entries from clip editorialTags", () => {
    const audioIndex = {
      clips: [{
        clipId: "clip02",
        editorialTags: ["impact", "traffic"],
        audioEvents: [],
      }],
    };

    const plan = buildSfxPlanFromAudio(audioIndex, { maxEntries: 5 });

    const impact = plan.find((entry) => entry.label === "impact");
    assert.ok(impact);
    assert.equal(impact.source, "library");
    assert.equal(impact.sfxId, "library/sfx/impact");
    assert.ok(!plan.some((entry) => entry.label === "traffic"));
  });

  it("respects maxEntries cap", () => {
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      audioEvents: Array.from({ length: 30 }, (_, index) => ({
        startSec: index,
        endSec: index + 0.5,
        label: "Bang",
        score: 0.5 + index * 0.01,
      })),
    }];

    const plan = buildSfxPlanFromAudio(audioIndex, { perClipAnalysis, maxEntries: 3 });
    assert.equal(plan.length, 3);
  });

  it("produces entries valid against SfxPlanEntrySchema", () => {
    const audioIndex = {
      clips: [{ clipId: "clip01", editorialTags: ["laughter"] }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      audioEvents: [{ startSec: 5, endSec: 5.6, label: "Laughter", score: 0.8 }],
    }];

    const plan = buildSfxPlanFromAudio(audioIndex, { perClipAnalysis });
    for (const entry of plan) {
      SfxPlanEntrySchema.parse(entry);
    }
  });
});
