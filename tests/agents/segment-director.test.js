import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSegmentDirectorBrief } from "../../src/agents/segment-director.js";
import { loadFixture } from "../../src/agents/test-helpers.js";
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
});
