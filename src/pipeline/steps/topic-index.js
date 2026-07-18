import path from "node:path";
import { TopicIndexSchema } from "../../schemas/edit-recipe-v2.js";
import { createOpenAIEmbedFn } from "../../agents/openai-client.js";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";
import { loadCatalogForFaceDetect } from "./face-detect.js";
import { collectObjectDetections } from "./spatial-index.js";
import { loadTwelveLabsByClip, mergeTwelveLabsIntoVisualText } from "../../lib/twelvelabs-merge.js";
import { ensureClipRegistry, runClipRegistryRefineStep } from "./clip-profile.js";

const STOP_WORDS = new Set([
  "i", "a", "w", "z", "na", "do", "to", "że", "się", "nie", "jak", "co", "ten", "ta",
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "is",
]);

const SEMANTIC_BLEND = { keyword: 0.5, embedding: 0.5 };
const EMBED_CHUNK_THRESHOLD = 100;
const EMBED_CHUNK_SIZE = 50;

export function mergeTimelineObjectDetections(timelineIndex, objectDetections) {
  return {
    ...timelineIndex,
    objectDetections: objectDetections.length > 0
      ? objectDetections
      : (timelineIndex.objectDetections ?? []),
  };
}

export async function embedTextsInChunks(texts, embedFn) {
  if (!embedFn || texts.length === 0) {
    return [];
  }
  if (texts.length <= EMBED_CHUNK_THRESHOLD) {
    return embedFn(texts);
  }

  const embeddings = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK_SIZE) {
    const chunk = texts.slice(i, i + EMBED_CHUNK_SIZE);
    const chunkEmbeddings = await embedFn(chunk);
    embeddings.push(...chunkEmbeddings);
  }
  return embeddings;
}

function tokenize(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

export function normalizeVector(vec) {
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vec;
  }
  return vec.map((value) => value / norm);
}

export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }
  return Math.max(0, Math.min(1, dot));
}

function textToTokenVector(text, dimensions = 64) {
  const vec = new Array(dimensions).fill(0);
  for (const token of tokenize(text)) {
    let hash = 0;
    for (let i = 0; i < token.length; i += 1) {
      hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
    }
    vec[hash % dimensions] += 1;
  }
  return normalizeVector(vec);
}

export function createTokenVectorEmbedFn(dimensions = 64) {
  return async (texts) => texts.map((text) => textToTokenVector(text, dimensions));
}

export function buildTopicEmbedText(topic, abstraction) {
  const l3Context = `${abstraction.L3?.sessionSummary ?? ""} ${abstraction.L3?.narrativeArc ?? ""}`.trim();
  return [topic.label, l3Context].filter(Boolean).join(" — ");
}

export function buildSceneVisualText(scene, l1, timelineIndex, workDir = null) {
  const captions = (timelineIndex.visionCaptions ?? []).filter((entry) => entry.sceneId === scene.sceneId);
  const baseParts = [
    ...(l1.topics ?? []),
    l1.summary ?? "",
  ];

  let tlMoments = [];
  let clipSummary = null;
  let tlArtifact = null;
  if (workDir) {
    tlArtifact = loadTwelveLabsByClip(workDir, scene.clipId);
    tlMoments = tlArtifact?.moments ?? [];
    clipSummary = tlArtifact?.clipSummary ?? tlArtifact?.editorial?.summary ?? null;
  }

  const visualText = [
    mergeTwelveLabsIntoVisualText(captions, tlMoments, scene, tlArtifact),
    clipSummary,
  ].filter(Boolean).join(" ");

  return [...baseParts, visualText].filter(Boolean).join(" ");
}

export function blendSemanticScore(keywordScore, embeddingScore) {
  if (embeddingScore == null) {
    return keywordScore;
  }
  return SEMANTIC_BLEND.keyword * keywordScore + SEMANTIC_BLEND.embedding * embeddingScore;
}

export function keywordOverlap(label, topics) {
  const labelTokens = new Set(tokenize(label));
  const uniqueTopicTokens = [...new Set(tokenize((topics ?? []).join(" ")))];
  if (labelTokens.size === 0 || uniqueTopicTokens.length === 0) {
    return 0;
  }
  const matches = uniqueTopicTokens.filter(
    (t) => labelTokens.has(t) || [...labelTokens].some((l) => l.includes(t) || t.includes(l)),
  );
  return matches.length / uniqueTopicTokens.length;
}

function visualQualityWeight(quality) {
  if (quality === "high") return 0.2;
  if (quality === "medium") return 0.1;
  return 0;
}

function stabilityWeight(stability) {
  if (stability === "stable") return 0.1;
  return 0;
}

function getL1ForScene(abstraction, sceneId) {
  return (abstraction.L1 ?? []).find((s) => s.sceneId === sceneId) ?? {};
}

function extractTopicsFromAbstraction(abstraction, timelineIndex, clipRegistry) {
  const topics = [];
  let topicCounter = 0;

  const l3Keywords = tokenize(
  `${abstraction.L3?.sessionSummary ?? ""} ${abstraction.L3?.narrativeArc ?? ""}`,
  );
  const keywordCounts = new Map();

  for (const segment of abstraction.L2 ?? []) {
    const tokens = tokenize(segment.summary);
    for (const token of tokens) {
      keywordCounts.set(token, (keywordCounts.get(token) ?? 0) + 1);
    }
  }

  const speechClips = clipRegistry.filter((c) => c.hasSpeech);

  for (const clipEntry of speechClips) {
    const clipWords = timelineIndex.words.filter((w) => w.wordId.startsWith(`${clipEntry.clipId}_`));
    const candidates = [...keywordCounts.entries()]
      .filter(([label, count]) => count >= 2 || l3Keywords.includes(label))
      .map(([label]) => label);

    const uniqueLabels = [...new Set([...candidates, ...l3Keywords])].slice(0, 10);

    for (const label of uniqueLabels) {
      const matchingWords = clipWords.filter((w) =>
        tokenize(w.word).some((t) => t.includes(label) || label.includes(t)),
      );
      if (matchingWords.length === 0) {
        continue;
      }

      topicCounter += 1;
      topics.push({
        topicId: `topic_${String(topicCounter).padStart(3, "0")}`,
        label,
        wordIds: matchingWords.map((w) => w.wordId),
        timeRange: {
          clipId: clipEntry.clipId,
          startSec: matchingWords[0].start,
          endSec: matchingWords.at(-1).end,
        },
        matchingScenes: [],
      });
    }
  }

  if (topics.length === 0 && speechClips.length > 0) {
    const clipEntry = speechClips[0];
    const clipWords = timelineIndex.words.filter((w) => w.wordId.startsWith(`${clipEntry.clipId}_`));
    if (clipWords.length > 0) {
      topics.push({
        topicId: "topic_001",
        label: abstraction.L3?.sessionSummary?.slice(0, 40) ?? "narracja",
        wordIds: clipWords.map((w) => w.wordId),
        timeRange: {
          clipId: clipEntry.clipId,
          startSec: clipWords[0].start,
          endSec: clipWords.at(-1).end,
        },
        matchingScenes: [],
      });
    }
  }

  return topics;
}

async function computeEmbeddingScores({
  topics,
  brollScenes,
  abstraction,
  timelineIndex,
  embedFn,
  workDir = null,
}) {
  if (!embedFn || topics.length === 0 || brollScenes.length === 0) {
    return new Map();
  }

  const topicTexts = topics.map((topic) => buildTopicEmbedText(topic, abstraction));
  const sceneTexts = brollScenes.map((scene) => {
    const l1 = getL1ForScene(abstraction, scene.sceneId);
    return buildSceneVisualText(scene, l1, timelineIndex, workDir);
  });

  const embeddings = await embedTextsInChunks([...topicTexts, ...sceneTexts], embedFn);
  const topicEmbeddings = embeddings.slice(0, topics.length);
  const sceneEmbeddings = embeddings.slice(topics.length);
  const scores = new Map();

  for (let topicIndex = 0; topicIndex < topics.length; topicIndex += 1) {
    for (let sceneIndex = 0; sceneIndex < brollScenes.length; sceneIndex += 1) {
      const key = `${topics[topicIndex].topicId}:${brollScenes[sceneIndex].sceneId}`;
      scores.set(
        key,
        cosineSimilarity(topicEmbeddings[topicIndex], sceneEmbeddings[sceneIndex]),
      );
    }
  }

  return scores;
}

function scoreSceneForTopic(topic, scene, l1, clipRegistry, objectDetections, excluded, embeddingScore = null) {
  const clipEntry = clipRegistry.find((c) => c.clipId === scene.clipId);
  const isBrollCandidate = clipEntry?.clipRole === "broll_pool" || !scene.hasSpeech;
  if (!isBrollCandidate) {
    return null;
  }

  for (const ex of excluded) {
    if (ex.usableAsBroll === false) {
      if (ex.exclusionType === "scene" && ex.sceneId === scene.sceneId) {
        return null;
      }
      if (ex.exclusionType === "whole_clip" && ex.clipId === scene.clipId) {
        return null;
      }
    }
  }

  let score = 0;
  const sceneTopics = l1.topics ?? clipEntry?.topics ?? [];
  const keywordScore = keywordOverlap(topic.label, sceneTopics);
  const semanticScore = blendSemanticScore(keywordScore, embeddingScore);
  score += 0.4 * semanticScore;

  const brollPotential = l1.brollPotential ?? (scene.hasSpeech ? 0.1 : 0.7);
  score += 0.3 * brollPotential;

  score += visualQualityWeight(l1.visualQuality ?? clipEntry?.visualQuality);
  score += stabilityWeight(l1.stability ?? "stable");

  const sceneDetections = objectDetections.filter((d) => d.sceneId === scene.sceneId);
  const labelMatch = sceneDetections.some((d) =>
    keywordOverlap(topic.label, [d.label]) > 0
    || d.label.toLowerCase().includes(topic.label.toLowerCase())
    || topic.label.toLowerCase().includes(d.label.toLowerCase()),
  );
  if (labelMatch) {
    score += 0.15;
  }

  if (score <= 0) {
    return null;
  }

  const reasons = [];
  if (keywordScore > 0) {
    reasons.push(`keyword: ${topic.label}`);
  } else if (embeddingScore != null && embeddingScore >= 0.5) {
    reasons.push(`embedding: ${topic.label}`);
  }
  if (labelMatch) {
    reasons.push(`visual: ${topic.label}`);
  }
  if (brollPotential >= 0.5) {
    reasons.push("brollPotential");
  }

  return {
    sceneId: scene.sceneId,
    score: Math.min(1, score),
    reason: reasons.join(", ") || "heuristic match",
  };
}

export class TopicIndexEmbeddingError extends Error {
  constructor(message = "Topic index wymaga embeddings — ustaw OPENAI_API_KEY") {
    super(message);
    this.name = "TopicIndexEmbeddingError";
    this.code = "TOPIC_INDEX_EMBEDDING_REQUIRED";
  }
}

export function resolveTopicIndexEmbedFn({
  embedFn,
  apiKey,
  allowKeywordOnly = false,
  quotaTracker = null,
  batchId = null,
} = {}) {
  if (embedFn) {
    return embedFn;
  }
  if (allowKeywordOnly) {
    return null;
  }
  const resolvedKey = apiKey ?? process.env.OPENAI_API_KEY;
  if (!resolvedKey) {
    throw new TopicIndexEmbeddingError();
  }
  return createOpenAIEmbedFn(resolvedKey, {
    quotaTracker,
    batchId,
    step: "topic_index",
  });
}

export async function buildTopicIndex({
  abstraction,
  timelineIndex,
  clipRegistry,
  threshold = 0.55,
  excluded = [],
  embedFn = null,
  workDir = null,
}) {
  if (!embedFn) {
    throw new TopicIndexEmbeddingError();
  }

  const topics = extractTopicsFromAbstraction(abstraction, timelineIndex, clipRegistry);
  const brollScenes = timelineIndex.scenes.filter((scene) => {
    const clipEntry = clipRegistry.find((c) => c.clipId === scene.clipId);
    return clipEntry?.clipRole === "broll_pool" || !scene.hasSpeech;
  });

  const embeddingScores = await computeEmbeddingScores({
    topics,
    brollScenes,
    abstraction,
    timelineIndex,
    embedFn,
    workDir,
  });

  for (const topic of topics) {
    const matches = [];
    for (const scene of brollScenes) {
      const l1 = getL1ForScene(abstraction, scene.sceneId);
      const embeddingScore = embedFn
        ? embeddingScores.get(`${topic.topicId}:${scene.sceneId}`) ?? 0
        : null;
      const match = scoreSceneForTopic(
        topic,
        scene,
        l1,
        clipRegistry,
        timelineIndex.objectDetections ?? [],
        excluded,
        embeddingScore,
      );
      if (match) {
        matches.push(match);
      }
    }
    matches.sort((a, b) => b.score - a.score);
    topic.matchingScenes = matches
      .filter((m) => m.score >= threshold)
      .slice(0, 5);
  }

  return {
    version: "2.0",
    batchId: timelineIndex.batchId,
    topics,
  };
}

export async function runTopicIndexStep({
  workDir,
  threshold = 0.55,
  force = false,
  embedFn,
  apiKey,
  allowKeywordOnly = false,
  dailyQuotaTracker = null,
  batchId = null,
}) {
  const outPath = path.join(workDir, ARTIFACTS.topicIndex);
  if (shouldUseCachedArtifact(workDir, ARTIFACTS.topicIndex, force)) {
    return readJson(outPath);
  }

  await ensureClipRegistry(workDir);
  await runClipRegistryRefineStep({ workDir });

  const timelinePath = path.join(workDir, ARTIFACTS.timelineIndex);
  const timelineIndex = readJson(timelinePath);
  const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
  const clipRegistryArtifact = readJson(path.join(workDir, ARTIFACTS.clipRegistry));
  const clipRegistry = clipRegistryArtifact.clipRegistry ?? clipRegistryArtifact;
  const catalog = loadCatalogForFaceDetect(workDir, null, timelineIndex);
  const objectDetections = collectObjectDetections(workDir, catalog);
  const timelineWithObjects = mergeTimelineObjectDetections(timelineIndex, objectDetections);

  const resolvedEmbedFn = resolveTopicIndexEmbedFn({
    embedFn,
    apiKey,
    allowKeywordOnly,
    quotaTracker: dailyQuotaTracker,
    batchId,
  });

  const index = await buildTopicIndex({
    abstraction,
    timelineIndex: timelineWithObjects,
    clipRegistry,
    threshold,
    embedFn: resolvedEmbedFn,
    workDir,
  });

  const parsed = TopicIndexSchema.parse(index);
  writeJson(outPath, parsed);
  return parsed;
}
