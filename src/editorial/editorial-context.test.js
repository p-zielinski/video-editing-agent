import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildDeadAirMontageHints,
  buildEditorialContext,
  buildTranscriptExcerpts,
  extractSceneIdsFromRecipe,
  formatSpatialSummary,
  spreadEditorialToPayload,
} from "./editorial-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const timelineIndex = JSON.parse(
  readFileSync(join(__dirname, "../agents/fixtures/timeline-index.json"), "utf8"),
);
const recipeDraft = JSON.parse(
  readFileSync(join(__dirname, "../agents/fixtures/recipe-draft.json"), "utf8"),
);

const spatialIndex = {
  version: "1.0",
  batchId: "testbatch",
  scenes: [
    {
      sceneId: "clip01_scene001",
      anchors: [{
        type: "subject",
        bbox: [0.2, 0.25, 0.4, 0.5],
        timestampSec: 5,
        label: "person",
        confidence: 0.8,
      }],
    },
    {
      sceneId: "clip01_scene002",
      anchors: [],
    },
  ],
};

const audioIndex = {
  version: "1.0",
  batchId: "testbatch",
  clips: [{
    clipId: "clip01",
    beatCount: 2,
    beatTimes: [0.5, 1.0],
  }],
};

describe("editorial-context", () => {
  it("extractSceneIdsFromRecipe collects unique scene ids from outputs", () => {
    const ids = extractSceneIdsFromRecipe(recipeDraft);
    assert.ok(ids.includes("clip01_scene001"));
    assert.ok(ids.includes("clip01_scene002"));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("formatSpatialSummary omits scenes without anchors", () => {
    const scenes = formatSpatialSummary(spatialIndex);
    assert.equal(scenes.length, 1);
    assert.equal(scenes[0].sceneId, "clip01_scene001");
    assert.equal(scenes[0].primaryAnchor.type, "subject");
  });

  it("buildTranscriptExcerpts filters by sceneIds", () => {
    const excerpts = buildTranscriptExcerpts(timelineIndex, {
      sceneIds: ["clip01_scene001"],
    });
    assert.equal(excerpts.length, 1);
    assert.equal(excerpts[0].sceneId, "clip01_scene001");
  });

  it("buildEditorialContext returns empty transcriptExcerpts without timelineIndex", () => {
    const ctx = buildEditorialContext({
      topicIndex: { topics: [] },
      includeFullTopicIndex: true,
    });
    assert.deepEqual(ctx.transcriptExcerpts, []);
    assert.equal(ctx.audioIndex, undefined);
    assert.deepEqual(ctx.topicIndex, { topics: [] });
  });

  it("includeFullTopicIndex=true returns full topic index", () => {
    const topicIndex = {
      topics: [{
        topicId: "t1",
        label: "intro",
        wordIds: ["clip01_w001"],
      }],
    };
    const ctx = buildEditorialContext({
      timelineIndex,
      topicIndex,
      includeFullTopicIndex: true,
    });
    assert.equal(ctx.topicIndex.topics[0].wordIds[0], "clip01_w001");
    assert.equal(ctx.topicIndex.topicCount, undefined);
  });

  it("includeFullTopicIndex=false returns compact topic summary", () => {
    const topicIndex = {
      topics: [{
        topicId: "t1",
        label: "intro",
        matchingScenes: [{ sceneId: "clip01_scene002", score: 0.8 }],
      }],
    };
    const ctx = buildEditorialContext({
      timelineIndex,
      topicIndex,
      includeFullTopicIndex: false,
    });
    assert.equal(ctx.topicIndex.topicCount, 1);
    assert.equal(ctx.topicIndex.topics[0].matchingScenes[0].sceneId, "clip01_scene002");
  });

  it("buildEditorialContext filters transcript excerpts by recipe scene ids", () => {
    const recipe = {
      outputs: [{
        timeline: [{
          videoRef: { sceneId: "clip01_scene001" },
          audioRef: { sceneId: "clip01_scene001" },
        }],
      }],
    };
    const ctx = buildEditorialContext({
      timelineIndex,
      recipe,
      includeFullTopicIndex: false,
    });
    assert.equal(ctx.transcriptExcerpts.length, 1);
    assert.equal(ctx.transcriptExcerpts[0].sceneId, "clip01_scene001");
  });

  it("buildEditorialContext includes audio and spatial summaries when provided", () => {
    const ctx = buildEditorialContext({
      timelineIndex,
      audioIndex,
      spatialIndex,
      includeFullTopicIndex: false,
    });
    assert.deepEqual(ctx.audioIndex.clips[0].beatTimestamps, [0.5, 1.0]);
    assert.equal(ctx.spatialIndex.scenes.length, 1);
    assert.equal(ctx.transcriptExcerpts.length, 2);
  });

  it("buildEditorialContext includes deadAirHints from timeline words", () => {
    const indexWithGaps = {
      ...audioIndex,
      clips: [{
        ...audioIndex.clips[0],
        silenceGaps: [{ startSec: 1, endSec: 64, durationSec: 63 }],
      }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 1, endSec: 64, durationSec: 63 }],
    }];

    const ctx = buildEditorialContext({
      timelineIndex,
      audioIndex: indexWithGaps,
      perClipAnalysis,
      includeFullTopicIndex: false,
    });

    const hints = ctx.audioIndex.clips[0].deadAirHints;
    assert.ok(hints?.length >= 1);
    assert.ok(hints.some((hint) => hint.source === "transcript" || hint.source === "both"));
  });

  it("buildDeadAirMontageHints suggests silence_beat for source both only", () => {
    const audioSummary = {
      clips: [{
        clipId: "clip01",
        deadAirHints: [
          { startSec: 72, endSec: 73.2, source: "both" },
          { startSec: 9, endSec: 72, source: "transcript" },
        ],
      }],
    };

    const montageHints = buildDeadAirMontageHints(audioSummary);
    assert.equal(montageHints.length, 1);
    assert.equal(montageHints[0].clipId, "clip01");
    assert.equal(montageHints[0].source, "both");
    assert.deepEqual(montageHints[0].suggestedTechniques, ["silence_beat", "hard_cut_energy"]);
    assert.match(montageHints[0].suggestion, /silence_beat/);
  });

  it("spreadEditorialToPayload spreads all fields at top level when nestKey is null", () => {
    const editorial = buildEditorialContext({
      timelineIndex,
      audioIndex,
      spatialIndex,
      topicIndex: {
        topics: [{
          topicId: "t1",
          label: "intro",
          matchingScenes: [{ sceneId: "clip01_scene002", score: 0.8 }],
        }],
      },
      includeFullTopicIndex: false,
    });
    const payload = spreadEditorialToPayload({ recipe: {} }, editorial);
    assert.equal(payload.transcriptExcerpts.length, 2);
    assert.equal(payload.audioIndex.clips[0].clipId, "clip01");
    assert.equal(payload.topicIndex.topicCount, 1);
    assert.equal(payload.spatialIndex.scenes.length, 1);
    assert.equal(payload.timelineCrossCheck, undefined);
  });

  it("spreadEditorialToPayload nests transcript+audio under timelineCrossCheck", () => {
    const editorial = buildEditorialContext({
      timelineIndex,
      audioIndex,
      topicIndex: {
        topics: [{
          topicId: "t1",
          label: "intro",
          matchingScenes: [{ sceneId: "clip01_scene002", score: 0.8 }],
        }],
      },
      spatialIndex,
      includeFullTopicIndex: false,
    });
    const payload = spreadEditorialToPayload(
      { timelineCrossCheck: { scenes: [{ sceneId: "clip01_scene001" }] } },
      editorial,
      { nestKey: "timelineCrossCheck" },
    );
    assert.equal(payload.timelineCrossCheck.scenes.length, 1);
    assert.equal(payload.timelineCrossCheck.transcriptExcerpts.length, 2);
    assert.equal(payload.timelineCrossCheck.audioIndex.clips[0].clipId, "clip01");
    assert.equal(payload.topicIndex.topicCount, 1);
    assert.equal(payload.spatialIndex.scenes.length, 1);
    assert.equal(payload.transcriptExcerpts, undefined);
    assert.equal(payload.audioIndex, undefined);
  });
});
