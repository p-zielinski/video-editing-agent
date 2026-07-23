import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertAbstractL1Integrity,
  bindL1SceneId,
  buildAbstractionBundle,
  buildL1BatchCacheKey,
  buildL1SceneCacheKey,
  expectedL1SceneIds,
  groupScenesForL1Summarization,
  isSilentSceneInput,
  summarizeScene,
  summarizeSceneBatch,
} from "./summarizer.js";
import { sceneSummaryInput } from "../lib/abstraction-chunking.js";
import { AbstractL1Schema, HookCreativeBriefSchema, EditorialAssessmentSchema } from "../schemas/edit-recipe.js";
import { createMockOpenAIClient, loadFixture } from "./test-helpers.js";
import { MODELS } from "./openai-client.js";
import { buildLlmCacheFileName, resolveLlmCacheDir } from "../lib/llm-response-cache.js";

function makeSilentScene(index) {
  return {
    sceneId: `clip01_scene${String(index).padStart(3, "0")}`,
    clipId: "clip01",
    startSec: index * 10,
    endSec: (index + 1) * 10,
    durationSec: 10,
    aspectRatio: "16:9",
    hasSpeech: false,
  };
}

function makeBatchL1Response(sceneIds) {
  return {
    scenes: sceneIds.map((sceneId) => ({
      sceneId,
      summary: `Cicha scena ${sceneId}.`,
      mood: "neutralny",
      keyMoments: [],
      brollPotential: 0.85,
      topics: [],
      visualQuality: "medium",
      stability: "unknown",
    })),
  };
}

describe("summarizer agent", () => {
  it("builds L1/L2/L3 bundle with mocked OpenAI", async () => {
    const timelineIndex = loadFixture("timeline-index.json");
    const l1 = loadFixture("summarizer-l1.json");
    const l2 = loadFixture("summarizer-l2.json");
    const l3 = loadFixture("summarizer-l3.json");

    const client = createMockOpenAIClient([l1, l1, l2, l3]);
    const bundle = await buildAbstractionBundle(client, timelineIndex, {
      userContext: "vlog dzień 66",
    });

    assert.equal(bundle.version, "1.0");
    assert.equal(bundle.batchId, "testbatch");
    assert.equal(bundle.L1.length, 2);
    assert.equal(bundle.L2.length, 1);
    assert.equal(bundle.L3.sessionSummary, l3.sessionSummary);
    assert.equal(bundle.L1[0].brollPotential, 0.15);
    assert.deepEqual(bundle.L1[0].topics, ["twarz", "pokój"]);
    assert.equal(bundle.L1[0].visualQuality, "high");
    assert.equal(bundle.L1[0].stability, "stable");
  });

  it("batches consecutive silent scenes into fewer GPT calls", async () => {
    const silentScenes = Array.from({ length: 10 }, (_, i) => makeSilentScene(i + 1));
    const timelineIndex = {
      version: "1.0",
      batchId: "silent-batch",
      clips: [{ clipId: "clip01", durationSec: 100 }],
      scenes: silentScenes,
      words: [],
      visionCaptions: [],
      stats: { totalDurationSec: 100, totalScenes: 10 },
    };

    const batch1Ids = silentScenes.slice(0, 8).map((s) => s.sceneId);
    const batch2Ids = silentScenes.slice(8).map((s) => s.sceneId);
    const l2 = loadFixture("summarizer-l2.json");
    const l3 = loadFixture("summarizer-l3.json");

    let apiCallCount = 0;
    const responses = [
      makeBatchL1Response(batch1Ids),
      makeBatchL1Response(batch2Ids),
      l2,
      l3,
    ];
    const client = createMockOpenAIClient(responses, { captureRequests: true });
    const originalCreate = client.chat.completions.create;
    client.chat.completions.create = async (...args) => {
      apiCallCount += 1;
      return originalCreate(...args);
    };

    const bundle = await buildAbstractionBundle(client, timelineIndex);

    assert.equal(bundle.L1.length, 10);
    assert.ok(apiCallCount < 10, `expected fewer than 10 API calls, got ${apiCallCount}`);
    assert.equal(apiCallCount, 4);

    const requests = client.getCapturedRequests();
    assert.deepEqual(
      requests.map((request) => request.model),
      [
        MODELS.summarizerL1,
        MODELS.summarizerL1,
        MODELS.summarizerL2,
        MODELS.summarizerL3,
      ],
    );
    const l1Tasks = requests
      .map((r) => JSON.parse(r.messages[1].content).task)
      .filter((task) => task.startsWith("L1_"));
    assert.deepEqual(l1Tasks, ["L1_batch_summary", "L1_batch_summary"]);
  });

  it("groups silent scenes with max 8 per batch", () => {
    const scenes = Array.from({ length: 10 }, (_, i) => makeSilentScene(i + 1));
    const groups = groupScenesForL1Summarization(scenes, [], []);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].type, "batch");
    assert.equal(groups[0].inputs.length, 8);
    assert.equal(groups[1].type, "batch");
    assert.equal(groups[1].inputs.length, 2);
  });

  it("keeps speech or visual scenes as individual L1 calls", () => {
    const scenes = [
      { ...makeSilentScene(1), startSec: 0, endSec: 10 },
      { ...makeSilentScene(2), startSec: 10, endSec: 20 },
      { ...makeSilentScene(3), hasSpeech: true, startSec: 20, endSec: 30 },
      { ...makeSilentScene(4), startSec: 30, endSec: 40 },
    ];
    const words = [
      { wordId: "clip01_w1", word: "cześć", start: 21, end: 21.5, isFiller: false, clipId: "clip01" },
    ];
    const visionCaptions = [];

    const groups = groupScenesForL1Summarization(scenes, words, visionCaptions);

    assert.equal(groups.length, 3);
    assert.equal(groups[0].type, "batch");
    assert.equal(groups[0].inputs.length, 2);
    assert.equal(groups[1].type, "single");
    assert.equal(groups[1].input.sceneId, scenes[2].sceneId);
    assert.equal(groups[2].type, "batch");
    assert.equal(groups[2].inputs.length, 1);
  });

  it("detects silent scene inputs without speech or visual captions", () => {
    const scene = makeSilentScene(1);
    const input = sceneSummaryInput(scene, [], []);
    assert.equal(isSilentSceneInput(input), true);

    const withSpeech = sceneSummaryInput(
      { ...scene, hasSpeech: true },
      [{ wordId: "clip01_w1", word: "hej", start: 11, end: 11.5, isFiller: false, clipId: "clip01" }],
      [],
    );
    assert.equal(isSilentSceneInput(withSpeech), false);

    const withVisual = sceneSummaryInput(
      scene,
      [],
      [{ sceneId: scene.sceneId, caption: "ulica", timestampSec: 1 }],
    );
    assert.equal(isSilentSceneInput(withVisual), false);
  });

  it("passes clipRegistry to L3 session summary in buildAbstractionBundle", async () => {
    const timelineIndex = loadFixture("timeline-index.json");
    const l1 = loadFixture("summarizer-l1.json");
    const l2 = loadFixture("summarizer-l2.json");
    const l3 = loadFixture("summarizer-l3.json");
    const clipRegistry = [
      {
        clipId: "clip03",
        clipRole: "narration_track",
        mediaType: "audio_only",
        hasSpeech: true,
      },
    ];

    const client = createMockOpenAIClient([l1, l1, l2, l3], { captureRequests: true });
    await buildAbstractionBundle(client, timelineIndex, { clipRegistry });

    const requests = client.getCapturedRequests();
    const l3Request = requests
      .map((r) => JSON.parse(r.messages[1].content))
      .find((payload) => payload.task === "L3_session_summary");

    assert.ok(l3Request, "expected L3_session_summary request");
    assert.deepEqual(l3Request.clipHints, [
      {
        clipId: "clip03",
        clipRole: "narration_track",
        mediaType: "audio_only",
        hasSpeech: true,
      },
    ]);
  });

  it("AbstractL1Schema accepts isNarrationSource: true from mocked L1 response", async () => {
    const timelineIndex = loadFixture("timeline-index.json");
    const l1Base = loadFixture("summarizer-l1.json");
    const l1WithNarration = { ...l1Base, isNarrationSource: true };
    const l2 = loadFixture("summarizer-l2.json");
    const l3 = loadFixture("summarizer-l3.json");

    const client = createMockOpenAIClient([l1WithNarration, l1WithNarration, l2, l3]);
    const bundle = await buildAbstractionBundle(client, timelineIndex);

    assert.equal(bundle.L1[0].isNarrationSource, true);
    assert.deepEqual(AbstractL1Schema.parse(l1WithNarration).isNarrationSource, true);
  });

  it("AbstractionBundle accepts hasSeparateNarration: true in L3", async () => {
    const timelineIndex = loadFixture("timeline-index.json");
    const l1 = loadFixture("summarizer-l1.json");
    const l2 = loadFixture("summarizer-l2.json");
    const l3WithVO = {
      ...loadFixture("summarizer-l3.json"),
      hasSeparateNarration: true,
    };

    const client = createMockOpenAIClient([l1, l1, l2, l3WithVO]);
    const bundle = await buildAbstractionBundle(client, timelineIndex, {
      clipRegistry: [{
        clipId: "clip03",
        clipRole: "narration_track",
        mediaType: "audio_only",
        hasSpeech: true,
      }],
    });

    assert.equal(bundle.L3.hasSeparateNarration, true);
  });

  it("AbstractionBundle accepts optional hookCreativeBrief on L3", async () => {
    const timelineIndex = loadFixture("timeline-index.json");
    const l1 = loadFixture("summarizer-l1.json");
    const l2 = loadFixture("summarizer-l2.json");
    const l3WithBrief = {
      ...loadFixture("summarizer-l3.json"),
      hookCreativeBrief: {
        strategy: "contextual",
        narrativePromise: "Obietnica bez spoilera",
        contextualLink: "Powiązanie z materiałem",
      },
    };

    const client = createMockOpenAIClient([l1, l1, l2, l3WithBrief], { captureRequests: true });
    const bundle = await buildAbstractionBundle(client, timelineIndex);

    assert.equal(bundle.L3.hookCreativeBrief.strategy, "contextual");
    HookCreativeBriefSchema.parse(bundle.L3.hookCreativeBrief);

    const l3Request = client.getCapturedRequests()
      .map((r) => JSON.parse(r.messages[1].content))
      .find((payload) => payload.task === "L3_session_summary");
    assert.ok(l3Request.outputSchema.hookCreativeBrief);
  });

  it("AbstractionBundle accepts optional editorialAssessment on L3", async () => {
    const timelineIndex = loadFixture("timeline-index.json");
    const l1 = loadFixture("summarizer-l1.json");
    const l2 = loadFixture("summarizer-l2.json");
    const l3WithAssessment = {
      ...loadFixture("summarizer-l3.json"),
      editorialAssessment: {
        editabilityScore: 0.45,
        verdict: "salvageable",
        storyCoherenceScore: 0.5,
        visualCoverageScore: 0.7,
        dialogueValueScore: 0.3,
        strengths: ["mocne ujęcia otoczenia"],
        constraints: ["poor_dialogue_audio", "weak_story"],
        recommendedSalvageModes: ["voice_over", "audio_enhancement"],
        reasoning: "Dialog trudny do zrozumienia, ale materiał wizualny wart montażu z VO.",
      },
    };

    const client = createMockOpenAIClient([l1, l1, l2, l3WithAssessment], { captureRequests: true });
    const bundle = await buildAbstractionBundle(client, timelineIndex, {
      audioIndex: {
        clips: [{
          clipId: "clip01",
          voiceLufs: -28,
          audioQualityGrade: "poor",
          audioQualityScore: 0.4,
          estimatedSnrDb: 8,
          windScore: 0.6,
          enhancementCandidateId: "enh_clip01",
        }],
      },
    });

    assert.equal(bundle.L3.editorialAssessment.verdict, "salvageable");
    EditorialAssessmentSchema.parse(bundle.L3.editorialAssessment);

    const l3Request = client.getCapturedRequests()
      .map((r) => JSON.parse(r.messages[1].content))
      .find((payload) => payload.task === "L3_session_summary");
    assert.ok(l3Request.audioQualitySummary?.length > 0);
    assert.ok(l3Request.outputSchema.editorialAssessment);
  });

  it("HookCreativeBriefSchema requires unexpectedElement for intentionally_unexpected", () => {
    const result = HookCreativeBriefSchema.safeParse({
      strategy: "intentionally_unexpected",
      narrativePromise: "Obietnica",
      contextualLink: "Link",
    });
    assert.equal(result.success, false);
  });

  it("buildL1SceneCacheKey differs per sceneId and maps to distinct cache files", () => {
    const a = buildL1SceneCacheKey("clip01_scene001");
    const b = buildL1SceneCacheKey("clip02_scene001");
    assert.notEqual(a, b);
    assert.notEqual(
      buildLlmCacheFileName({ step: "abstract", role: "summarizerL1", cacheKey: a }),
      buildLlmCacheFileName({ step: "abstract", role: "summarizerL1", cacheKey: b }),
    );
  });

  it("buildL1BatchCacheKey is stable for sorted sceneIds and changes when membership changes", () => {
    const keyAb = buildL1BatchCacheKey(["clip02_scene001", "clip01_scene001"]);
    const keyBa = buildL1BatchCacheKey(["clip01_scene001", "clip02_scene001"]);
    const keyOnlyA = buildL1BatchCacheKey(["clip01_scene001"]);
    assert.equal(keyAb, keyBa);
    assert.notEqual(keyAb, keyOnlyA);
    assert.match(keyAb, /^batch_/);
  });

  it("bindL1SceneId overwrites LLM sceneId with the requesting input sceneId", () => {
    const bound = bindL1SceneId(
      {
        sceneId: "clip01_scene001",
        summary: "Spacer z psem.",
        mood: "spokojny",
        keyMoments: [],
        brollPotential: 0.5,
        topics: ["pies"],
        visualQuality: "medium",
        stability: "stable",
      },
      "clip17_scene001",
    );
    assert.equal(bound.sceneId, "clip17_scene001");
    assert.equal(bound.summary, "Spacer z psem.");
  });

  it("summarizeScene rewrites wrong LLM sceneId and writes per-scene cache file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-l1-cache-"));
    try {
      const sceneInput = {
        sceneId: "clip17_scene001",
        transcript: "hej",
        visual: "pokój",
      };
      const client = createMockOpenAIClient([{
        sceneId: "clip01_scene001",
        summary: "Zatruta odpowiedź z clip01.",
        mood: "neutralny",
        keyMoments: [],
        brollPotential: 0.2,
        topics: ["pokój"],
        visualQuality: "medium",
        stability: "stable",
      }]);

      const summary = await summarizeScene(client, sceneInput, {
        batchId: "batchl1",
        step: "abstract",
        workDir: tmpDir,
      });

      assert.equal(summary.sceneId, "clip17_scene001");
      const cachePath = path.join(
        resolveLlmCacheDir("batchl1", tmpDir),
        buildLlmCacheFileName({
          step: "abstract",
          role: "summarizerL1",
          cacheKey: buildL1SceneCacheKey("clip17_scene001"),
        }),
      );
      assert.ok(fs.existsSync(cachePath), `expected cache file at ${cachePath}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("summarizeScene uses distinct cache files for different sceneIds", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-l1-cache-multi-"));
    try {
      const makeResponse = (sceneId) => ({
        sceneId: "wrong_scene",
        summary: `Summary for ${sceneId}`,
        mood: "neutralny",
        keyMoments: [],
        brollPotential: 0.3,
        topics: [],
        visualQuality: "medium",
        stability: "unknown",
      });
      const client = createMockOpenAIClient([
        makeResponse("clip01_scene001"),
        makeResponse("clip02_scene001"),
      ]);

      await summarizeScene(client, { sceneId: "clip01_scene001", transcript: "a", visual: "" }, {
        batchId: "batchl1",
        step: "abstract",
        workDir: tmpDir,
      });
      await summarizeScene(client, { sceneId: "clip02_scene001", transcript: "b", visual: "" }, {
        batchId: "batchl1",
        step: "abstract",
        workDir: tmpDir,
      });

      const cacheDir = resolveLlmCacheDir("batchl1", tmpDir);
      const files = fs.readdirSync(cacheDir).sort();
      assert.deepEqual(files, [
        buildLlmCacheFileName({
          step: "abstract",
          role: "summarizerL1",
          cacheKey: buildL1SceneCacheKey("clip01_scene001"),
        }),
        buildLlmCacheFileName({
          step: "abstract",
          role: "summarizerL1",
          cacheKey: buildL1SceneCacheKey("clip02_scene001"),
        }),
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("summarizeSceneBatch maps wrong LLM sceneIds by index, binds input ids, and uses batch cacheKey", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-l1-batch-"));
    try {
      const inputs = [
        { sceneId: "clip01_scene001", transcript: "", visual: "" },
        { sceneId: "clip01_scene002", transcript: "", visual: "" },
      ];
      const client = createMockOpenAIClient([{
        scenes: [
          {
            sceneId: "clip99_scene001",
            summary: "Cicha scena A.",
            mood: "neutralny",
            keyMoments: [],
            brollPotential: 0.8,
            topics: [],
            visualQuality: "medium",
            stability: "unknown",
          },
          {
            sceneId: "clip99_scene002",
            summary: "Cicha scena B.",
            mood: "neutralny",
            keyMoments: [],
            brollPotential: 0.8,
            topics: [],
            visualQuality: "medium",
            stability: "unknown",
          },
        ],
      }]);

      const resolved = await summarizeSceneBatch(client, inputs, {
        batchId: "batchl1",
        step: "abstract",
        workDir: tmpDir,
      });
      assert.deepEqual(resolved.map((s) => s.sceneId), [
        "clip01_scene001",
        "clip01_scene002",
      ]);
      assert.equal(resolved[0].summary, "Cicha scena A.");
      assert.equal(resolved[1].summary, "Cicha scena B.");

      const batchCache = path.join(
        resolveLlmCacheDir("batchl1", tmpDir),
        buildLlmCacheFileName({
          step: "abstract",
          role: "summarizerL1",
          cacheKey: buildL1BatchCacheKey(inputs.map((s) => s.sceneId)),
        }),
      );
      assert.ok(fs.existsSync(batchCache), `expected batch cache at ${batchCache}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("summarizeSceneBatch binds sceneIds when LLM returns matching ids with wrong labels", async () => {
    const inputs = [
      { sceneId: "clip01_scene001", transcript: "", visual: "" },
      { sceneId: "clip01_scene002", transcript: "", visual: "" },
    ];
    const client = createMockOpenAIClient([{
      scenes: [
        {
          sceneId: "clip01_scene001",
          summary: "Scena pierwsza.",
          mood: "neutralny",
          keyMoments: [],
          brollPotential: 0.8,
          topics: [],
          visualQuality: "medium",
          stability: "unknown",
        },
        {
          sceneId: "clip01_scene002",
          summary: "Scena druga.",
          mood: "neutralny",
          keyMoments: [],
          brollPotential: 0.8,
          topics: [],
          visualQuality: "medium",
          stability: "unknown",
        },
      ],
    }]);

    const resolved = await summarizeSceneBatch(client, inputs, {
      batchId: null,
      step: null,
    });
    assert.equal(resolved[0].sceneId, "clip01_scene001");
    assert.equal(resolved[1].sceneId, "clip01_scene002");
    assert.equal(resolved[0].summary, "Scena pierwsza.");
    assert.equal(resolved[1].summary, "Scena druga.");
  });
});

describe("assertAbstractL1Integrity", () => {
  it("passes when unique sceneIds and summaries match expected diversity", () => {
    const l1 = [
      { sceneId: "a", summary: "Pierwsza scena o domu." },
      { sceneId: "b", summary: "Druga scena o parku." },
      { sceneId: "c", summary: "Trzecia scena o sklepie." },
    ];
    const result = assertAbstractL1Integrity(l1, ["a", "b", "c"]);
    assert.equal(result.uniqueSceneIds, 3);
    assert.equal(result.uniqueSummaries, 3);
  });

  it("fails when unique sceneIds collapse to one with many expected", () => {
    const l1 = Array.from({ length: 10 }, () => ({
      sceneId: "clip01_scene001",
      summary: "Ten sam tekst.",
    }));
    assert.throws(
      () => assertAbstractL1Integrity(l1, Array.from({ length: 10 }, (_, i) => `clip${i}_scene001`)),
      (error) => {
        assert.equal(error.code, "ABSTRACT_L1_INTEGRITY");
        assert.equal(error.uniqueSceneIds, 1);
        assert.match(error.message, /integrity/i);
        assert.match(error.message, /--from-step abstract --to-step abstract/);
        assert.doesNotMatch(error.message, /--to-step abstract --force/);
        return true;
      },
    );
  });

  it("fails when sceneIds look unique but summaries are all identical (cache poison after bind)", () => {
    const expected = Array.from({ length: 8 }, (_, i) => `clip${String(i + 1).padStart(2, "0")}_scene001`);
    const l1 = expected.map((sceneId) => ({
      sceneId,
      summary: "Identyczny opis spaceru z psem z clip01.",
    }));
    assert.throws(
      () => assertAbstractL1Integrity(l1, expected),
      (error) => {
        assert.equal(error.code, "ABSTRACT_L1_INTEGRITY");
        assert.equal(error.uniqueSummaries, 1);
        assert.match(error.message, /summar/i);
        return true;
      },
    );
  });

  it("fails when unique/expected ratio is below 0.5", () => {
    const expected = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const l1 = [
      { sceneId: "s0", summary: "A" },
      { sceneId: "s1", summary: "B" },
      { sceneId: "s0", summary: "C" },
      { sceneId: "s1", summary: "D" },
    ];
    assert.throws(
      () => assertAbstractL1Integrity(l1, expected),
      (error) => error.code === "ABSTRACT_L1_INTEGRITY",
    );
  });

  it("expectedL1SceneIds excludes ai_generated clips", () => {
    const ids = expectedL1SceneIds(
      {
        scenes: [
          { sceneId: "clip01_scene001", clipId: "clip01" },
          { sceneId: "ai_hook_01_scene001", clipId: "ai_hook_01" },
        ],
      },
      [
        { clipId: "clip01", clipRole: "primary" },
        { clipId: "ai_hook_01", clipRole: "ai_generated" },
      ],
    );
    assert.deepEqual(ids, ["clip01_scene001"]);
  });
});
