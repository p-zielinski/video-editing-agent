import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSfxPlanFromAudio, enrichRecipeSfxPlan, trimSfxPlanToDensityCap, validateSfxNarrativeOnly } from "../../src/editorial/sfx-plan.js";
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
    assert.equal(impact.sfxId, "impact_heavy_01");
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

describe("enrichRecipeSfxPlan", () => {
  const audioIndex = {
    clips: [{ clipId: "clip01", editorialTags: ["laughter"] }],
  };
  const perClipAnalysis = [{
    clipId: "clip01",
    audioEvents: [
      { startSec: 8.5, endSec: 9.1, label: "Laughter", score: 0.74 },
      { startSec: 22.0, endSec: 22.4, label: "Squeak", score: 0.61 },
      { startSec: 1.2, endSec: 2.0, label: "Speech", score: 0.88 },
    ],
  }];
  const clipRegistry = [{ clipId: "clip01", sourcePath: "clip01.mp4" }];

  it("fills empty sfxPlan with high-confidence audio_event entries", () => {
    const recipe = {
      outputs: [{ outputId: "main" }],
      sfxPlan: [],
      clipRegistry,
    };

    const plan = enrichRecipeSfxPlan(recipe, { audioIndex, clipRegistry, perClipAnalysis });

    assert.ok(plan.length >= 1);
    assert.ok(plan.every((entry) => entry.source === "audio_event"));
    const laughter = plan.find((entry) => entry.label === "laughter");
    assert.ok(laughter);
    assert.equal(laughter.clipId, "clip01");
    assert.ok(!plan.some((entry) => entry.label === "speech"));
  });

  it("preserves existing director entries and only adds missing events", () => {
    const recipe = {
      outputs: [{ outputId: "main" }],
      sfxPlan: [{
        sfxId: "sfx_whoosh_hook",
        source: "library",
        label: "whoosh",
        outputStartSec: 0,
        outputEndSec: 0.5,
        volumeDb: -6,
      }],
      clipRegistry,
    };

    const plan = enrichRecipeSfxPlan(recipe, { audioIndex, clipRegistry, perClipAnalysis });

    assert.equal(plan[0].label, "whoosh");
    assert.ok(plan.length > 1);
    assert.ok(plan.some((entry) => entry.label === "laughter" && entry.source === "audio_event"));
  });

  it("does not duplicate events already covered by director", () => {
    const recipe = {
      outputs: [{ outputId: "main" }],
      sfxPlan: [{
        sfxId: "evt_clip01_8500",
        source: "audio_event",
        clipId: "clip01",
        anchorTimeSec: 8.5,
        label: "laughter",
        outputStartSec: 8.5,
        outputEndSec: 9.1,
        volumeDb: -6,
      }],
      clipRegistry,
    };

    const plan = enrichRecipeSfxPlan(recipe, { audioIndex, clipRegistry, perClipAnalysis });

    const laughter = plan.filter((entry) => entry.label === "laughter");
    assert.equal(laughter.length, 1);
  });

  it("respects maxSfxEntries cap per L2 rhythm", () => {
    const sfxTimelineIndex = {
      scenes: [
        { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
        { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
      ],
    };
    const sfxAbstraction = {
      L2: [
        {
          segmentId: "seg_slow",
          startSec: 0,
          endSec: 120,
          sceneIds: ["clip01_scene001"],
        },
        {
          segmentId: "seg_fast",
          startSec: 120,
          endSec: 240,
          sceneIds: ["clip01_scene002"],
        },
      ],
    };
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 240,
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 240,
          audioInSec: 0,
          audioOutSec: 240,
          audioPolicy: "from_video_ref",
        }],
      }],
      sfxPlan: [],
      clipRegistry,
      narrativeProfile: {
        segments: [
          { l2SegmentId: "seg_slow", rhythm: "slow" },
          { l2SegmentId: "seg_fast", rhythm: "fast" },
        ],
      },
    };
    const manyEvents = Array.from({ length: 8 }, (_, index) => ({
      startSec: index * 15 + 5,
      endSec: index * 15 + 5.5,
      label: "Laughter",
      score: 0.9 - index * 0.01,
    }));

    const plan = enrichRecipeSfxPlan(recipe, {
      audioIndex,
      clipRegistry,
      perClipAnalysis: [{ clipId: "clip01", audioEvents: manyEvents }],
      abstraction: sfxAbstraction,
      timelineIndex: sfxTimelineIndex,
    });

    const slowSfx = plan.filter((entry) => (entry.anchorTimeSec ?? entry.outputStartSec) < 120);
    const fastSfx = plan.filter((entry) => (entry.anchorTimeSec ?? entry.outputStartSec) >= 120);
    assert.equal(slowSfx.length, 0);
    assert.ok(fastSfx.length <= 3);
  });

  it("caps total entries at 6 per output", () => {
    const manyEvents = Array.from({ length: 20 }, (_, index) => ({
      startSec: index + 10,
      endSec: index + 10.5,
      label: "Laughter",
      score: 0.9 - index * 0.01,
    }));
    const recipe = {
      outputs: [{ outputId: "main" }, { outputId: "short" }],
      sfxPlan: [],
      clipRegistry,
    };

    const plan = enrichRecipeSfxPlan(recipe, {
      audioIndex,
      clipRegistry,
      perClipAnalysis: [{ clipId: "clip01", audioEvents: manyEvents }],
    });

    assert.equal(plan.length, 12);
  });

  it("skips tags without catalog stub", () => {
    const recipe = {
      outputs: [{ outputId: "main" }],
      sfxPlan: [],
      clipRegistry,
    };
    const squeakOnly = {
      clips: [{ clipId: "clip01" }],
    };
    const squeakAnalysis = [{
      clipId: "clip01",
      audioEvents: [{ startSec: 3, endSec: 3.4, label: "Squeak", score: 0.8 }],
    }];

    const plan = enrichRecipeSfxPlan(recipe, {
      audioIndex: squeakOnly,
      clipRegistry,
      perClipAnalysis: squeakAnalysis,
    });

    assert.equal(plan.length, 0);
  });

  it("skips enrich SFX when sfxNarrativeOnly and no narrative anchors", () => {
    const recipe = {
      outputs: [{ outputId: "main", outputKind: "main" }],
      sfxPlan: [],
      clipRegistry,
      narrativeProfile: { sfxNarrativeOnly: true },
      creativeMoments: [],
    };

    const plan = enrichRecipeSfxPlan(recipe, { audioIndex, clipRegistry, perClipAnalysis });

    assert.equal(plan.length, 0);
  });

  it("sfxNarrativeOnly only adds SFX near hook/payoff/cold-open anchors", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
          outputStartSec: 0,
          outputEndSec: 30,
        }],
      }],
      sfxPlan: [],
      clipRegistry,
      narrativeProfile: { sfxNarrativeOnly: true },
      creativeMoments: [{
        momentId: "hook_01",
        techniqueId: "snap_zoom",
        retentionRole: "hook",
        outputId: "main_16x9",
        outputStartSec: 0,
        outputEndSec: 2,
      }],
    };
    const hookEventAnalysis = [{
      clipId: "clip01",
      audioEvents: [
        { startSec: 0.5, endSec: 1.1, label: "Laughter", score: 0.74 },
        { startSec: 22.0, endSec: 22.4, label: "Laughter", score: 0.8 },
      ],
    }];

    const plan = enrichRecipeSfxPlan(recipe, {
      audioIndex,
      clipRegistry,
      perClipAnalysis: hookEventAnalysis,
    });

    assert.equal(plan.length, 1);
    assert.equal(plan[0].anchorTimeSec, 0.5);
    assert.ok(!plan.some((entry) => entry.anchorTimeSec === 22));
  });

  it("sfxNarrativeOnly maps anchor through dead_air cuts when wordIndexes provided", () => {
    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
        { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
      ],
    }];
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
          cuts: [{
            startWordId: "clip01_w001",
            endWordId: "clip01_w002",
            reason: "dead_air",
          }],
        }],
      }],
      sfxPlan: [],
      clipRegistry,
      narrativeProfile: { sfxNarrativeOnly: true },
      creativeMoments: [{
        momentId: "hook_01",
        techniqueId: "snap_zoom",
        retentionRole: "hook",
        outputId: "main_16x9",
        outputStartSec: 0,
        outputEndSec: 2,
      }],
    };
    const postCutEventAnalysis = [{
      clipId: "clip01",
      audioEvents: [
        { startSec: 6.5, endSec: 7.1, label: "Laughter", score: 0.74 },
        { startSec: 22.0, endSec: 22.4, label: "Laughter", score: 0.8 },
      ],
    }];

    const withWordIndexes = enrichRecipeSfxPlan(recipe, {
      audioIndex,
      clipRegistry,
      perClipAnalysis: postCutEventAnalysis,
      wordIndexes,
    });
    assert.equal(withWordIndexes.length, 1);
    assert.equal(withWordIndexes[0].anchorTimeSec, 6.5);
    assert.equal(withWordIndexes[0].outputStartSec, 2.5);

    const withoutWordIndexes = enrichRecipeSfxPlan(recipe, {
      audioIndex,
      clipRegistry,
      perClipAnalysis: postCutEventAnalysis,
    });
    assert.equal(withoutWordIndexes.length, 0);
  });

  it("returns existing plan when audio index is missing", () => {
    const existing = [{
      sfxId: "whoosh",
      source: "library",
      label: "whoosh",
      outputStartSec: 0,
      outputEndSec: 0.4,
      volumeDb: -6,
    }];
    const recipe = { outputs: [{ outputId: "main" }], sfxPlan: existing };

    assert.deepEqual(enrichRecipeSfxPlan(recipe, { audioIndex: null }), existing);
  });

  it("trims merged sfxPlan to V24-06 density cap preferring director entries", () => {
    const manyEvents = Array.from({ length: 10 }, (_, index) => ({
      startSec: index + 10,
      endSec: index + 10.5,
      label: "Laughter",
      score: 0.9 - index * 0.05,
    }));
    const recipe = {
      outputs: [{
        outputId: "main",
        outputKind: "main",
        timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
      }],
      sfxPlan: [{
        sfxId: "sfx_whoosh_hook",
        source: "library",
        label: "whoosh",
        outputStartSec: 0,
        outputEndSec: 0.5,
        volumeDb: -6,
      }],
      clipRegistry,
    };

    const plan = enrichRecipeSfxPlan(recipe, {
      audioIndex,
      clipRegistry,
      perClipAnalysis: [{ clipId: "clip01", audioEvents: manyEvents }],
    });

    assert.equal(plan.length, 2);
    assert.equal(plan[0].label, "whoosh");
    assert.ok(plan.some((entry) => entry.label === "laughter" && entry.source === "audio_event"));
  });
});

describe("trimSfxPlanToDensityCap", () => {
  it("keeps all entries when within cap", () => {
    const recipe = {
      outputs: [{
        outputId: "main",
        outputKind: "main",
        timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
      }],
      sfxPlan: [
        { sfxId: "a", source: "library", label: "whoosh", outputStartSec: 0, outputEndSec: 0.5 },
        { sfxId: "b", source: "library", label: "click", outputStartSec: 50, outputEndSec: 50.5 },
      ],
    };

    const trimmed = trimSfxPlanToDensityCap(recipe, { directorEntryCount: 1 });
    assert.equal(trimmed.length, 2);
  });

  it("drops lowest-score enrich candidates first", () => {
    const recipe = {
      outputs: [{
        outputId: "main",
        outputKind: "main",
        timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
      }],
      sfxPlan: [
        { sfxId: "director", source: "library", label: "whoosh", outputStartSec: 0, outputEndSec: 0.5 },
        {
          sfxId: "enrich_low",
          source: "audio_event",
          label: "laughter",
          outputStartSec: 10,
          outputEndSec: 10.5,
          reason: "Detected laughter (score 0.55)",
        },
        {
          sfxId: "enrich_high",
          source: "audio_event",
          label: "laughter",
          outputStartSec: 20,
          outputEndSec: 20.5,
          reason: "Detected laughter (score 0.90)",
        },
      ],
    };

    const trimmed = trimSfxPlanToDensityCap(recipe, { directorEntryCount: 1 });
    assert.equal(trimmed.length, 2);
    assert.equal(trimmed[0].sfxId, "director");
    assert.equal(trimmed[1].sfxId, "enrich_high");
  });

  it("remapSfxPlanToOutputTimeline maps clip-local times to output timeline", async () => {
    const { remapSfxPlanToOutputTimeline } = await import("../../src/editorial/sfx-plan.js");

    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 10,
          videoOutSec: 20,
          audioInSec: 10,
          audioOutSec: 20,
          audioPolicy: "from_video_ref",
          outputStartSec: 0,
          outputEndSec: 10,
        }],
      }],
      sfxPlan: [{
        sfxId: "evt_clip01_15000",
        source: "audio_event",
        clipId: "clip01",
        anchorTimeSec: 15,
        outputStartSec: 15,
        outputEndSec: 15.4,
        volumeDb: -6,
        label: "laughter",
      }],
    };

    const remapped = remapSfxPlanToOutputTimeline(recipe);
    assert.equal(remapped[0].outputStartSec, 5);
    assert.equal(remapped[0].outputEndSec, 5.4);
  });
});

describe("validateSfxNarrativeOnly", () => {
  it("V24-08 when sfxNarrativeOnly and entry outside narrative anchors", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
          outputStartSec: 0,
          outputEndSec: 30,
        }],
      }],
      clipRegistry: [{ clipId: "clip01", durationSec: 30 }],
      narrativeProfile: { sfxNarrativeOnly: true },
      creativeMoments: [{
        momentId: "hook_01",
        techniqueId: "snap_zoom",
        retentionRole: "hook",
        outputId: "main_16x9",
        outputStartSec: 0,
        outputEndSec: 2,
      }],
      sfxPlan: [{
        sfxId: "evt_far",
        source: "audio_event",
        clipId: "clip01",
        anchorTimeSec: 22,
        outputStartSec: 22,
        outputEndSec: 22.4,
        volumeDb: -6,
        label: "laughter",
      }],
    };

    const issues = validateSfxNarrativeOnly(recipe);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "V24-08");
  });

  it("passes when sfxNarrativeOnly entry is near hook anchor", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
          outputStartSec: 0,
          outputEndSec: 30,
        }],
      }],
      clipRegistry: [{ clipId: "clip01", durationSec: 30 }],
      narrativeProfile: { sfxNarrativeOnly: true },
      creativeMoments: [{
        momentId: "hook_01",
        techniqueId: "snap_zoom",
        retentionRole: "hook",
        outputId: "main_16x9",
        outputStartSec: 0,
        outputEndSec: 2,
      }],
      sfxPlan: [{
        sfxId: "evt_near",
        source: "audio_event",
        clipId: "clip01",
        anchorTimeSec: 0.5,
        outputStartSec: 0.5,
        outputEndSec: 1.1,
        volumeDb: -6,
        label: "laughter",
      }],
    };

    const issues = validateSfxNarrativeOnly(recipe);
    assert.equal(issues.length, 0);
  });
});
