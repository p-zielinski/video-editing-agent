import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSegmentDirectorBrief, runSegmentDirector } from "../../src/agents/segment-director.js";
import { createMockOpenAIClient, loadFixture } from "../../src/agents/test-helpers.js";
import { buildMiniDaySegmentPartial } from "../../src/test-helpers/mock-openai-client.js";
import { ARTIFACTS, writeJson } from "../../src/pipeline/work-paths.js";

describe("segment-director brief parity", () => {
  it("includes narrativeProfile fields from buildDirectorBrief via recipe skeleton", () => {
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const superPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1, targetKeepRatio: 0.5 }],
      crossSegmentNotes: ["callback: restaurant"],
      creativityProfile: {
        level: "balanced",
        techniquePack: "youtube_vlog_2026",
        maxTechniqueDensityPerMin: 0.3,
      },
      narrativeProfile: {
        mode: "internet_documentary",
        segments: [{
          l2SegmentId: "seg001",
          rhythm: "normal",
          retentionIntensity: "medium",
          silencePolicy: "trim_dead_air",
        }],
      },
    };

    const brief = buildSegmentDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry: [{ clipId: "clip01", sortIndex: 0 }],
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [],
      userContext: "",
      requiredFormats: ["16:9", "9:16"],
      batchContext: {},
      keyframesByClip: {},
    }, {
      segmentId: "seg001",
      sceneIds: ["clip01_scene001", "clip01_scene002"],
      superPlan,
    });

    assert.ok(brief.narrativeProfile);
    assert.ok(brief.creativityBudgetByL2Segment?.seg001);
    assert.equal(brief.creativityBudget, brief.creativityBudgetByL2Segment.seg001);
    assert.equal(brief.segmentNarrativeProfile?.l2SegmentId, "seg001");
    assert.ok(brief.segmentScope);
    assert.ok(brief.creativityBudget);
    assert.ok(brief.emotionalBeatHints == null || Array.isArray(brief.emotionalBeatHints));
  });

  it("uses timelineIndex.userContext when CLI userContext is empty", () => {
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = {
      ...loadFixture("timeline-index.json"),
      userContext: "Keep the cooking montage energetic",
    };
    const superPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1 }],
      globalTheme: "food vlog",
      creativityProfile: { level: "balanced" },
    };

    const brief = buildSegmentDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry: [{ clipId: "clip01", sortIndex: 0 }],
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [],
      userContext: "",
      requiredFormats: ["16:9"],
      batchContext: {},
      keyframesByClip: {},
    }, {
      segmentId: "seg001",
      sceneIds: ["clip01_scene001"],
      superPlan,
    });

    assert.match(brief.userContext, /cooking montage/);
  });

  it("scopes wordIndexes to clips present in segment timeline", () => {
    const abstraction = loadFixture("abstraction.json");
    const baseTimeline = loadFixture("timeline-index.json");
    const timelineIndex = {
      ...baseTimeline,
      clips: [
        ...baseTimeline.clips,
        { clipId: "clip02", sourcePath: "/inbox/clip02.mp4", durationSec: 60 },
      ],
      scenes: [
        ...baseTimeline.scenes,
        {
          sceneId: "clip02_scene001",
          clipId: "clip02",
          startSec: 0,
          endSec: 60,
          durationSec: 60,
          hasSpeech: true,
        },
      ],
      words: [
        ...baseTimeline.words,
        { wordId: "clip02_w001", word: "extra", start: 1, end: 1.4, isFiller: false },
      ],
    };

    const brief = buildSegmentDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry: [
        { clipId: "clip01", sortIndex: 0 },
        { clipId: "clip02", sortIndex: 1 },
      ],
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [
        { clipId: "clip01", words: baseTimeline.words },
        { clipId: "clip02", words: [{ wordId: "clip02_w001", word: "extra" }] },
      ],
      userContext: "",
      requiredFormats: ["16:9"],
      batchContext: {},
      keyframesByClip: {},
    }, {
      segmentId: "seg001",
      sceneIds: ["clip01_scene001"],
      superPlan: {
        segmentOrder: ["seg001"],
        segmentPicks: [{ segmentId: "seg001", priority: 1 }],
        creativityProfile: { level: "balanced" },
      },
    });

    assert.ok(brief.sceneMap.some((scene) => scene.sceneId === "clip01_scene001"));
    assert.ok(brief.sceneMap.every((scene) => scene.sceneId !== "clip02_scene001"));
    assert.deepEqual(Object.keys(brief.clipAspectById ?? {}), ["clip01"]);
  });

  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-seg-dir-"));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("includes twelveLabsMoments when workDir is provided", () => {
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    writeJson(path.join(workDir, ARTIFACTS.twelvelabs("clip01")), {
      version: "1.0",
      clipId: "clip01",
      indexingStatus: "ready",
      editorial: {
        summary: "Chef plating pasta in a busy kitchen",
        mood: "energetic",
        editingHints: ["match cut on plating"],
      },
      moments: [{ startSec: 2, endSec: 8, description: "close-up plating" }],
      chapters: [{ startSec: 0, endSec: 60, title: "Kitchen prep" }],
    });

    const brief = buildSegmentDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry: [{ clipId: "clip01", sortIndex: 0 }],
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [],
      userContext: "",
      requiredFormats: ["16:9"],
      batchContext: {},
      keyframesByClip: {},
      workDir,
    }, {
      segmentId: "seg001",
      sceneIds: ["clip01_scene001", "clip01_scene002"],
      superPlan: {
        segmentOrder: ["seg001"],
        segmentPicks: [{ segmentId: "seg001", priority: 1 }],
        creativityProfile: { level: "balanced" },
      },
    });

    assert.ok(Array.isArray(brief.twelveLabsMoments));
    assert.equal(brief.twelveLabsMoments[0].clipId, "clip01");
    assert.match(brief.twelveLabsMoments[0].clipSummary, /pasta/i);
  });

  it("includes aiHook only for canonical first segment", () => {
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const aiVideoArtifact = {
      status: "succeeded",
      clipId: "ai_hook_01",
      sceneId: "ai_hook_01_scene001",
      durationSec: 5,
      prompt: "test",
      plan: { generateAudio: false },
    };
    const superPlan = {
      segmentOrder: ["seg002", "seg001"],
      canonicalSegmentOrder: ["seg002", "seg001"],
      segmentPicks: [
        { segmentId: "seg001", priority: 2 },
        { segmentId: "seg002", priority: 1 },
      ],
      creativityProfile: { level: "balanced" },
    };

    const firstBrief = buildSegmentDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry: [{ clipId: "clip01", sortIndex: 0 }],
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [],
      userContext: "",
      requiredFormats: ["9:16"],
      batchContext: {},
      keyframesByClip: {},
      aiVideoArtifact,
    }, {
      segmentId: "seg002",
      sceneIds: ["clip01_scene001"],
      superPlan,
    });

    const secondBrief = buildSegmentDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry: [{ clipId: "clip01", sortIndex: 0 }],
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [],
      userContext: "",
      requiredFormats: ["9:16"],
      batchContext: {},
      keyframesByClip: {},
      aiVideoArtifact,
    }, {
      segmentId: "seg001",
      sceneIds: ["clip01_scene002"],
      superPlan,
    });

    assert.ok(firstBrief.aiHook);
    assert.equal(firstBrief.aiHook.clipId, "ai_hook_01");
    assert.equal(secondBrief.aiHook, undefined);
  });
});

describe("runSegmentDirector", () => {
  const baseContext = () => {
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const superPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1, targetKeepRatio: 0.5 }],
      crossSegmentNotes: [],
      creativityProfile: { level: "balanced", techniquePack: "youtube_vlog_2026" },
      narrativeProfile: {
        mode: "retention_vlog",
        segments: [{
          l2SegmentId: "seg001",
          rhythm: "normal",
          retentionIntensity: "medium",
          silencePolicy: "trim_dead_air",
        }],
      },
    };

    return {
      abstraction,
      timelineIndex,
      clipRegistry: [{
        clipId: "clip01",
        fileName: "clip01.mp4",
        durationSec: 120,
        sortIndex: 0,
        clipRole: "aroll_primary",
        roleConfidence: 0.75,
        roleSource: "clip_profile",
        hasSpeech: true,
        speechWordCount: timelineIndex.words?.length ?? 0,
      }],
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [{ clipId: "clip01", words: timelineIndex.words }],
      userContext: "",
      requiredFormats: ["16:9", "9:16"],
      batchContext: { theme: "vlog" },
      keyframesByClip: {},
      superPlan,
      segmentId: "seg001",
      sceneIds: abstraction.L2[0].sceneIds,
    };
  };

  it("defaults recipe version to 2.4 when model omits version", async () => {
    const ctx = baseContext();
    const modelRecipe = buildMiniDaySegmentPartial("seg001");
    delete modelRecipe.version;

    const client = createMockOpenAIClient([modelRecipe], { captureRequests: true });
    const { recipe } = await runSegmentDirector(client, ctx, {
      segmentId: ctx.segmentId,
      sceneIds: ctx.sceneIds,
      superPlan: ctx.superPlan,
    });

    assert.equal(recipe.version, "2.4");
    assert.equal(client.getCapturedRequests().length, 1);
  });

  it("backfills shortsRetentionProfile from brief when model omits it", async () => {
    const ctx = baseContext();
    const modelRecipe = buildMiniDaySegmentPartial("seg001");
    delete modelRecipe.shortsRetentionProfile;

    const brief = buildSegmentDirectorBrief(ctx, {
      segmentId: ctx.segmentId,
      sceneIds: ctx.sceneIds,
      superPlan: ctx.superPlan,
    });
    assert.ok(brief.shortsRetentionProfile, "fixture brief should include shorts retention for dual format");

    const client = createMockOpenAIClient([modelRecipe]);
    const { recipe } = await runSegmentDirector(client, ctx, {
      segmentId: ctx.segmentId,
      sceneIds: ctx.sceneIds,
      superPlan: ctx.superPlan,
    });

    assert.ok(recipe.shortsRetentionProfile);
    assert.equal(recipe.shortsRetentionProfile.enabled, brief.shortsRetentionProfile.enabled);
    assert.equal(
      recipe.shortsRetentionProfile.techniquePack,
      brief.shortsRetentionProfile.techniquePack,
    );
    assert.equal(
      recipe.shortsRetentionProfile.retentionBeatIntervalSec,
      brief.shortsRetentionProfile.retentionBeatIntervalSec,
    );
  });
});
