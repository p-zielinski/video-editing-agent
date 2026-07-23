import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDirectorBrief,
  buildDraftRecipeFingerprint,
  buildDrillDownUserPayload,
  EDIT_RECIPE_V2_OUTPUT_SCHEMA,
} from "./director.js";
import { buildSegmentDirectorBrief } from "./segment-director.js";
import { measureBriefPayload } from "../lib/brief-metrics.js";
import {
  DIRECTOR_BRIEF_CAPS,
  SEGMENT_BRIEF_ESTIMATED_TOKEN_BUDGET,
} from "../editorial/brief-caps.js";
import { formatCatalogForPrompt, formatCatalogIdListForPrompt } from "../editorial/format-catalog-for-prompt.js";
import { loadTechniqueCatalog } from "../editorial/load-technique-catalog.js";
import { computeCreativityBudget } from "../editorial/technique-budget.js";
import { loadFixture, createMockOpenAIClient } from "./test-helpers.js";
import { directorDrillDown } from "./director.js";

/**
 * Threshold for diverse-L1 segment brief (est. tokens = jsonBytes/4).
 * Documented in .cursor/work/brief-slim.md — target <40k prompt tokens/segment.
 */
const DIVERSE_L1_SEGMENT_TOKEN_BUDGET = SEGMENT_BRIEF_ESTIMATED_TOKEN_BUDGET;

function loadDiverse() {
  return {
    abstraction: loadFixture("abstract-diverse-l1/abstraction.json"),
    timelineIndex: loadFixture("abstract-diverse-l1/timeline-index.json"),
    clipRegistry: loadFixture("abstract-diverse-l1/clip-registry.json"),
    audioIndex: loadFixture("abstract-diverse-l1/audio-index.json"),
    recipeDraft: loadFixture("abstract-diverse-l1/recipe-draft.json"),
  };
}

describe("abstract-diverse-l1 fixture integrity", () => {
  it("has ≥8 unique L1 sceneIds with diverse summaries and ≥2 L2 segments", () => {
    const { abstraction } = loadDiverse();
    const ids = abstraction.L1.map((e) => e.sceneId);
    const unique = new Set(ids);
    assert.ok(unique.size >= 8, `expected ≥8 unique L1, got ${unique.size}`);
    assert.equal(ids.length, unique.size, "L1 sceneIds must be unique");

    const summaries = new Set(abstraction.L1.map((e) => e.summary));
    assert.equal(summaries.size, abstraction.L1.length, "L1 summaries must be diverse");

    assert.ok(abstraction.L2.length >= 2);
    for (const seg of abstraction.L2) {
      assert.ok(seg.summary?.length > 20, `${seg.segmentId} needs a real summary`);
      assert.ok(seg.sceneIds?.length > 0);
      for (const sceneId of seg.sceneIds) {
        assert.ok(unique.has(sceneId), `L2 ${seg.segmentId} references unknown ${sceneId}`);
      }
    }
    assert.ok(abstraction.L3?.sessionSummary);
  });
});

describe("brief slim — segment brief metrics", () => {
  it("diverse-L1 segment brief stays under estimated token budget", () => {
    const { abstraction, timelineIndex, clipRegistry, audioIndex } = loadDiverse();
    const sceneIds = abstraction.L2[0].sceneIds;

    const brief = buildSegmentDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [],
      userContext: "vlog dzień w mieście",
      requiredFormats: ["16:9", "9:16"],
      batchContext: { inputMode: "multi_clip_day" },
      keyframesByClip: {},
    }, {
      segmentId: "seg001",
      sceneIds,
      superPlan: {
        segmentOrder: ["seg001", "seg002"],
        segmentPicks: [
          { segmentId: "seg001", priority: 1, targetKeepRatio: 0.4 },
          { segmentId: "seg002", priority: 2, targetKeepRatio: 0.35 },
        ],
        creativityProfile: {
          level: "balanced",
          techniquePack: "youtube_vlog_2026",
          maxTechniqueDensityPerMin: 0.35,
        },
        canonicalSegmentOrder: ["seg001", "seg002"],
      },
    });

    const userJson = JSON.stringify({
      task: "segment_director_draft",
      brief,
      // schema is large; segment still sends it — budget must include it
      outputSchema: EDIT_RECIPE_V2_OUTPUT_SCHEMA,
    });
    const metric = measureBriefPayload({
      task: "segment_director_draft",
      userJson,
      brief,
      segmentId: "seg001",
    });

    assert.ok(
      metric.estimatedTokens < DIVERSE_L1_SEGMENT_TOKEN_BUDGET,
      `segment brief estTokens ${metric.estimatedTokens} >= budget ${DIVERSE_L1_SEGMENT_TOKEN_BUDGET} `
        + `(jsonBytes=${metric.jsonBytes})`,
    );
    assert.ok(brief.l1SceneSummaries?.length > 0, "expects L1 summaries when clean L1 present");
    assert.ok(brief.techniqueCatalog);
    // Compact catalog: either id-list shape or truncated techniques without heavy whenToUse dump
    const techJson = JSON.stringify(brief.techniqueCatalog);
    assert.ok(
      techJson.length <= DIRECTOR_BRIEF_CAPS.TECHNIQUE_CATALOG_MAX_CHARS,
      `techniqueCatalog ${techJson.length} chars exceeds max ${DIRECTOR_BRIEF_CAPS.TECHNIQUE_CATALOG_MAX_CHARS}`,
    );
  });

  it("reduces maxWordsPerScene when L1 coverage is good", () => {
    const { abstraction, timelineIndex, clipRegistry } = loadDiverse();
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex: { topics: [] },
      requiredFormats: ["16:9"],
      batchContext: { inputMode: "multi_clip_day" },
    });

    const speechExcerpts = (brief.transcriptExcerpts ?? []).filter((e) => e.words?.length);
    assert.ok(speechExcerpts.length > 0);
    for (const excerpt of speechExcerpts) {
      assert.ok(
        excerpt.words.length <= DIRECTOR_BRIEF_CAPS.maxWordsPerSceneWhenL1Good,
        `${excerpt.sceneId} has ${excerpt.words.length} words; expected ≤ ${DIRECTOR_BRIEF_CAPS.maxWordsPerSceneWhenL1Good}`,
      );
    }
  });
});

describe("brief slim — technique catalog compaction", () => {
  it("formatCatalogForPrompt respects maxChars via compact rows", () => {
    const catalog = loadTechniqueCatalog();
    const budget = computeCreativityBudget(600, { level: "balanced" });
    const full = formatCatalogForPrompt(catalog, budget, { maxChars: Infinity });
    const fullLen = JSON.stringify(full).length;
    assert.ok(fullLen > DIRECTOR_BRIEF_CAPS.TECHNIQUE_CATALOG_MAX_CHARS);

    const capped = formatCatalogForPrompt(catalog, budget, {
      maxChars: DIRECTOR_BRIEF_CAPS.TECHNIQUE_CATALOG_MAX_CHARS,
    });
    const cappedLen = JSON.stringify(capped).length;
    assert.ok(cappedLen <= DIRECTOR_BRIEF_CAPS.TECHNIQUE_CATALOG_MAX_CHARS);
    assert.ok(capped.compact === true || capped.techniques.every((t) => !t.whenToUse || t.whenToUse.length < 80));
  });

  it("formatCatalogIdListForPrompt is smaller than full catalog", () => {
    const catalog = loadTechniqueCatalog();
    const budget = computeCreativityBudget(600, { level: "balanced" });
    const full = formatCatalogForPrompt(catalog, budget, { maxChars: Infinity });
    const ids = formatCatalogIdListForPrompt(catalog, budget);
    assert.ok(ids.techniqueIds?.length > 0);
    assert.ok(JSON.stringify(ids).length < JSON.stringify(full).length);
  });
});

describe("brief slim — drill-down payload", () => {
  it("omits full draftRecipe and outputSchema; uses fingerprint + scene details", () => {
    const { abstraction, timelineIndex, clipRegistry, audioIndex, recipeDraft } = loadDiverse();
    const sceneIds = recipeDraft.outputs.flatMap((o) =>
      (o.timeline ?? []).flatMap((s) => [s.videoRef?.sceneId, s.audioRef?.sceneId].filter(Boolean)),
    );

    const { payload: slim } = buildDrillDownUserPayload({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex,
      userContext: "vlog",
      requiredFormats: ["16:9", "9:16"],
      batchContext: {},
      recipe: recipeDraft,
      sceneIds,
    });

    assert.equal(slim.task, "drill_down_refine");
    assert.equal(slim.draftRecipe, undefined);
    assert.equal(slim.outputSchema, undefined);
    assert.ok(slim.draftRecipeFingerprint);
    assert.ok(slim.outputTimelinesSummary?.length > 0);
    assert.ok(slim.drillDownSceneDetails?.length > 0);
    assert.ok(Array.isArray(slim.fixInstructions));
    assert.ok(slim.techniqueCatalog?.techniqueIds || slim.techniqueCatalog?.compact);
  });

  it("drill-down payload bytes drop vs legacy full-recipe shape", () => {
    const { abstraction, timelineIndex, clipRegistry, audioIndex, recipeDraft } = loadDiverse();
    const sceneIds = [...new Set(
      recipeDraft.outputs.flatMap((o) =>
        (o.timeline ?? []).flatMap((s) => [s.videoRef?.sceneId, s.audioRef?.sceneId].filter(Boolean)),
      ),
    )];

    const { payload: slim } = buildDrillDownUserPayload({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex,
      userContext: "vlog",
      requiredFormats: ["16:9", "9:16"],
      batchContext: {},
      recipe: recipeDraft,
      sceneIds,
    });

    const legacyShape = {
      ...slim,
      draftRecipe: recipeDraft,
      outputSchema: EDIT_RECIPE_V2_OUTPUT_SCHEMA,
      techniqueCatalog: formatCatalogForPrompt(
        loadTechniqueCatalog(),
        computeCreativityBudget(600, { level: "balanced" }),
        { maxChars: Infinity },
      ),
    };
    delete legacyShape.draftRecipeFingerprint;
    delete legacyShape.outputTimelinesSummary;
    delete legacyShape.fixInstructions;

    const slimBytes = Buffer.byteLength(JSON.stringify(slim), "utf8");
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacyShape), "utf8");
    assert.ok(
      slimBytes < legacyBytes * 0.75,
      `slim ${slimBytes} should be <75% of legacy ${legacyBytes}`,
    );
    assert.ok(!("draftRecipe" in slim) || slim.draftRecipe == null);
    assert.ok(!("outputSchema" in slim) || slim.outputSchema == null);
  });

  it("buildDraftRecipeFingerprint drops bulky segment fields", () => {
    const { recipeDraft } = loadDiverse();
    const fp = buildDraftRecipeFingerprint(recipeDraft);
    const fpJson = JSON.stringify(fp);
    assert.ok(!fpJson.includes("debugNotes"));
    assert.ok(fp.outputs?.[0]?.timeline?.[0]?.segmentId);
    assert.ok(fpJson.length < JSON.stringify(recipeDraft).length);
  });

  it("directorDrillDown sends slim payload to the model", async () => {
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const draft = loadFixture("recipe-draft.json");
    const refined = loadFixture("fixer-response.json");
    const client = createMockOpenAIClient([refined], { captureRequests: true });

    await directorDrillDown(client, {
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
        speechWordCount: 3,
      }],
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: loadFixture("abstract-diverse-l1/audio-index.json"),
      userContext: "vlog",
      requiredFormats: ["16:9", "9:16"],
      recipe: draft,
      sceneIds: ["clip01_scene001", "clip01_scene002"],
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.equal(payload.draftRecipe, undefined);
    assert.equal(payload.outputSchema, undefined);
    assert.ok(payload.draftRecipeFingerprint);
  });
});
