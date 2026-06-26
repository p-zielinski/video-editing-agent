import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTopicIndex,
  cosineSimilarity,
  createTokenVectorEmbedFn,
  embedTextsInChunks,
  keywordOverlap,
  normalizeVector,
  runTopicIndexStep,
} from "./topic-index.js";
import { ARTIFACTS, writeJson } from "../work-paths.js";

const clipRegistry = [
  { clipId: "clip01", hasSpeech: true, clipRole: "aroll_primary", speechWordCount: 10 },
  { clipId: "clip02", hasSpeech: false, clipRole: "broll_pool", speechWordCount: 0, topics: ["jedzenie"] },
];

const abstraction = {
  L2: [
    { segmentId: "s1", summary: "Rozmowa o restauracji i jedzeniu w mieście", sceneIds: ["clip01_scene001"] },
  ],
  L3: { sessionSummary: "Vlog o restauracji i jedzeniu" },
  L1: [
    { sceneId: "clip02_scene001", brollPotential: 0.9, topics: ["jedzenie", "restauracja"], visualQuality: "high", stability: "stable" },
  ],
};

const timelineIndex = {
  batchId: "test01",
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 60, hasSpeech: true },
    { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 30, hasSpeech: false },
  ],
  words: [
    { wordId: "clip01_w001", word: "restauracja", start: 10, end: 11, isFiller: false },
    { wordId: "clip01_w002", word: "jedzenie", start: 12, end: 13, isFiller: false },
    { wordId: "clip01_w003", word: "restauracja", start: 44, end: 45, isFiller: false },
  ],
  objectDetections: [
    { sceneId: "clip02_scene001", label: "food", timestampSec: 5 },
  ],
};

function createSemanticMockEmbedFn() {
  const axes = [
    /\b(restaurac\w*|jedzen\w*|food|dining|meal|makaron|danie|talery?)\b/i,
    /\b(muzeum|museum|sztuk\w*|art)\b/i,
  ];

  return async (texts) => texts.map((text) => {
    const vec = axes.map((pattern) => (pattern.test(text) ? 1 : 0));
    return normalizeVector(vec);
  });
}

describe("topic_index", () => {
  it("extracts topics and scores matching broll scenes above threshold", async () => {
    const index = await buildTopicIndex({
      abstraction,
      timelineIndex,
      clipRegistry,
      threshold: 0.55,
    });

    assert.ok(index.topics.length >= 1);
    const restauracja = index.topics.find((t) => t.label.includes("restauracja") || t.label.includes("jedzeniu"));
    assert.ok(restauracja, "expected topic about restauracja/jedzenie");
    assert.ok(restauracja.wordIds.length > 0);
    assert.ok(restauracja.matchingScenes.length > 0);
    assert.ok(restauracja.matchingScenes[0].score >= 0.55);
    assert.equal(restauracja.matchingScenes[0].sceneId, "clip02_scene001");
    assert.equal(index.version, "1.0");
  });

  it("filters scenes below threshold", async () => {
    const index = await buildTopicIndex({
      abstraction,
      timelineIndex,
      clipRegistry,
      threshold: 0.99,
    });

    for (const topic of index.topics) {
      assert.equal(topic.matchingScenes.length, 0);
    }
  });

  it("includes L3 keywords even when L2 count is 1", async () => {
    const index = await buildTopicIndex({
      abstraction: {
        L2: [
          { segmentId: "s1", summary: "Krótka wzmianka o muzeum", sceneIds: ["clip01_scene001"] },
        ],
        L3: { sessionSummary: "Wycieczka do muzeum sztuki" },
        L1: abstraction.L1,
      },
      timelineIndex: {
        ...timelineIndex,
        words: [
          ...timelineIndex.words,
          { wordId: "clip01_w010", word: "muzeum", start: 20, end: 21, isFiller: false },
        ],
      },
      clipRegistry,
      threshold: 0.55,
    });

    const muzeum = index.topics.find((t) => t.label === "muzeum");
    assert.ok(muzeum, "L3 keyword muzeum should appear as topic despite single L2 occurrence");
    assert.ok(muzeum.wordIds.includes("clip01_w010"));
  });

  it("limits to top 5 matching scenes per topic", async () => {
    const manyScenes = Array.from({ length: 8 }, (_, i) => ({
      sceneId: `clip02_scene${String(i + 1).padStart(3, "0")}`,
      clipId: "clip02",
      startSec: i * 10,
      endSec: (i + 1) * 10,
      hasSpeech: false,
    }));
    const index = await buildTopicIndex({
      abstraction: {
        ...abstraction,
        L1: manyScenes.map((s) => ({
          sceneId: s.sceneId,
          brollPotential: 0.9,
          topics: ["jedzenie"],
          visualQuality: "high",
          stability: "stable",
        })),
      },
      timelineIndex: {
        ...timelineIndex,
        scenes: [...timelineIndex.scenes, ...manyScenes],
        objectDetections: manyScenes.map((s) => ({ sceneId: s.sceneId, label: "food", timestampSec: 1 })),
      },
      clipRegistry,
      threshold: 0.55,
    });

    for (const topic of index.topics) {
      assert.ok(topic.matchingScenes.length <= 5);
    }
  });

  it("embedding improves match for synonym case (restauracja topic vs jedzenie scene visual)", async () => {
    const synonymAbstraction = {
      L2: [{ segmentId: "s1", summary: "Rozmowa o restauracji", sceneIds: ["clip01_scene001"] }],
      L3: { sessionSummary: "Vlog o restauracji" },
      L1: [{
        sceneId: "clip02_scene001",
        brollPotential: 0.3,
        topics: ["jedzenie"],
        summary: "B-roll jedzenia na talerzu",
        visualQuality: "high",
        stability: "stable",
      }],
    };
    const synonymTimeline = {
      batchId: "test02",
      scenes: [
        { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 60, hasSpeech: true },
        { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 30, hasSpeech: false },
      ],
      words: [
        { wordId: "clip01_w001", word: "restauracji", start: 10, end: 11, isFiller: false },
        { wordId: "clip01_w002", word: "restauracji", start: 12, end: 13, isFiller: false },
      ],
      visionCaptions: [
        { sceneId: "clip02_scene001", caption: "apetyczne jedzenie na talerzu", tags: ["jedzenie"] },
      ],
      objectDetections: [],
    };

    const keywordOnly = await buildTopicIndex({
      abstraction: synonymAbstraction,
      timelineIndex: synonymTimeline,
      clipRegistry,
      threshold: 0.55,
      embedFn: null,
    });
    const withEmbedding = await buildTopicIndex({
      abstraction: synonymAbstraction,
      timelineIndex: synonymTimeline,
      clipRegistry,
      threshold: 0.55,
      embedFn: createSemanticMockEmbedFn(),
    });

    const topicKeyword = keywordOnly.topics.find((t) => t.label === "restauracji");
    const topicEmbed = withEmbedding.topics.find((t) => t.label === "restauracji");
    assert.ok(topicKeyword, "expected topic label restauracji");
    assert.ok(topicEmbed, "expected topic label restauracji");

    const keywordMatchScore = topicKeyword.matchingScenes.find((m) => m.sceneId === "clip02_scene001")?.score ?? 0;
    const embedMatch = topicEmbed.matchingScenes.find((m) => m.sceneId === "clip02_scene001");
    assert.equal(keywordMatchScore, 0, "keyword-only path should miss synonym scene below threshold");
    assert.ok(embedMatch, "embedding path should match synonym scene");
    assert.ok(embedMatch.score >= 0.55);
    assert.match(embedMatch.reason, /embedding: restauracji/i);
    assert.equal(withEmbedding.version, "2.0");
  });

  it("stub mode works without API (keyword-only path)", async () => {
    const index = await buildTopicIndex({
      abstraction,
      timelineIndex,
      clipRegistry,
      threshold: 0.55,
      embedFn: null,
    });

    assert.equal(index.version, "1.0");
    assert.ok(index.topics.some((topic) => topic.matchingScenes.length > 0));
  });

  it("token vector embed fn gives higher cosine for shared tokens", async () => {
    const embedFn = createTokenVectorEmbedFn(32);
    const [restauracjaVec, jedzenieVec, muzeumVec] = await embedFn([
      "restauracja vlog",
      "restauracja jedzenie",
      "muzeum sztuki",
    ]);

    assert.ok(cosineSimilarity(restauracjaVec, jedzenieVec) > cosineSimilarity(restauracjaVec, muzeumVec));
  });

  it("runTopicIndexStep uses fresh 04-objects detections over stale timeline objectDetections", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-topic-objects-"));
    try {
      const isolatedAbstraction = {
        L2: [
          { segmentId: "s1", summary: "jedzenie jedzenie smaczne", sceneIds: ["clip01_scene001"] },
        ],
        L3: { sessionSummary: "Vlog o jedzeniu" },
        L1: [
          {
            sceneId: "clip02_scene001",
            brollPotential: 0.9,
            topics: ["krajobraz"],
            visualQuality: "high",
            stability: "stable",
          },
        ],
      };
      const isolatedTimeline = {
        batchId: "test01",
        scenes: [
          { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 60, hasSpeech: true },
          { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 30, hasSpeech: false },
        ],
        words: [
          { wordId: "clip01_w001", word: "jedzenie", start: 10, end: 11, isFiller: false },
          { wordId: "clip01_w002", word: "jedzenie", start: 12, end: 13, isFiller: false },
        ],
        objectDetections: [],
      };

      writeJson(path.join(workDir, ARTIFACTS.timelineIndex), isolatedTimeline);
      writeJson(path.join(workDir, ARTIFACTS.abstraction), isolatedAbstraction);
      writeJson(path.join(workDir, ARTIFACTS.clipRegistry), { clipRegistry });
      writeJson(path.join(workDir, ARTIFACTS.objects("clip02")), {
        detections: [
          { sceneId: "clip02_scene001", label: "jedzenie", timestampSec: 5 },
        ],
      });

      const index = await runTopicIndexStep({ workDir, force: true, stub: true });
      const jedzenie = index.topics.find((t) => t.label === "jedzenie");
      assert.ok(jedzenie, "expected topic jedzenie");
      const match = jedzenie.matchingScenes.find((m) => m.sceneId === "clip02_scene001");
      assert.ok(match, "fresh object detection should boost broll scene match");
      assert.match(match.reason, /visual: jedzenie/i);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keywordOverlap returns continuous score for partial token overlap", () => {
    assert.equal(keywordOverlap("restauracja", ["restauracja"]), 1);
    assert.equal(keywordOverlap("restauracja", ["jedzenie"]), 0);
    const partial = keywordOverlap("restauracja", ["jedzenie", "restauracja", "miasto"]);
    assert.ok(partial > 0 && partial < 1, "expected partial overlap between 0 and 1");
    assert.equal(partial, 1 / 3);
  });

  it("embedTextsInChunks batches large embed requests", async () => {
    let callCount = 0;
    const embedFn = async (texts) => {
      callCount += 1;
      assert.ok(texts.length <= 50);
      return texts.map(() => [1, 0]);
    };

    const texts = Array.from({ length: 105 }, (_, i) => `text-${i}`);
    const embeddings = await embedTextsInChunks(texts, embedFn);

    assert.equal(embeddings.length, 105);
    assert.equal(callCount, 3);
  });
});
