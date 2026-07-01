import fs from "node:fs";
import path from "node:path";
import { ClipRegistryArtifactSchema } from "../../schemas/edit-recipe-v2.js";
import { parseBatchContextFromUserContext } from "../../lib/input-mode.js";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";
import { topEditorialTagNames } from "../../editorial/audio-event-tags.js";

function inferVisualQualityFromIndex({ captionCount, detectionCount }) {
  if (captionCount >= 3 && detectionCount >= 1) {
    return "high";
  }
  if (captionCount >= 1) {
    return "medium";
  }
  return "low";
}

function computeClipStats(clip, timelineIndex) {
  const scenes = timelineIndex.scenes.filter((s) => s.clipId === clip.clipId);
  const words = timelineIndex.words.filter((w) => w.wordId.startsWith(`${clip.clipId}_`));
  const speechWordCount = words.length;
  const fillerCount = words.filter((w) => w.isFiller).length;
  const fillerRatio = speechWordCount > 0 ? fillerCount / speechWordCount : 0;

  const sceneIds = new Set(scenes.map((s) => s.sceneId));
  const captions = (timelineIndex.visionCaptions ?? []).filter((c) => sceneIds.has(c.sceneId));
  const detections = (timelineIndex.objectDetections ?? []).filter((d) => sceneIds.has(d.sceneId));
  const keyframes = (timelineIndex.keyframes ?? []).filter((k) => sceneIds.has(k.sceneId));

  const speechScenes = scenes.filter((s) => s.hasSpeech).length;
  const speechSceneRatio = scenes.length > 0 ? speechScenes / scenes.length : 0;

  const shakecamScenes = scenes.filter(
    (s) => (s.cutScore ?? 0) > 0.35 && (s.durationSec ?? 0) < 15,
  ).length;
  const lowStability = scenes.length > 0 && shakecamScenes / scenes.length > 0.5;

  const hasSpeech = speechWordCount > 0;

  return {
    scenes,
    hasSpeech,
    speechWordCount,
    fillerRatio,
    captions,
    detections,
    keyframes,
    speechSceneRatio,
    lowStability,
    visualQuality: inferVisualQualityFromIndex({
      captionCount: captions.length,
      detectionCount: detections.length,
    }),
  };
}

function assignClipRole(stats, medianWordCount, clip = {}) {
  const {
    hasSpeech,
    speechWordCount,
    fillerRatio,
    captions,
    detections,
    keyframes,
    lowStability,
    speechSceneRatio,
  } = stats;

  if (clip.mediaType === "audio_only" && hasSpeech) {
    return { clipRole: "narration_track", roleConfidence: 0.85 };
  }

  if (!hasSpeech && (captions.length >= 1 || detections.length >= 1 || keyframes.length >= 2)) {
    return { clipRole: "broll_pool", roleConfidence: 0.7 };
  }

  if (hasSpeech && fillerRatio > 0.6 && lowStability) {
    return { clipRole: "outtakes", roleConfidence: 0.6 };
  }

  if (hasSpeech) {
    if (speechWordCount >= medianWordCount && speechSceneRatio >= 0.5) {
      return { clipRole: "aroll_primary", roleConfidence: 0.75 };
    }
    return { clipRole: "aroll_secondary", roleConfidence: 0.65 };
  }

  if (keyframes.length >= 1 || captions.length >= 1) {
    return { clipRole: "broll_pool", roleConfidence: 0.55 };
  }

  return { clipRole: "undecided", roleConfidence: 0.3 };
}

function buildVisualSummary(stats) {
  const captionTexts = stats.captions.slice(0, 5).map((c) => c.caption);
  const labels = [...new Set(stats.detections.map((d) => d.label))].slice(0, 5);
  const parts = [];
  if (captionTexts.length) {
    parts.push(captionTexts.join("; "));
  }
  if (labels.length) {
    parts.push(`obiekty: ${labels.join(", ")}`);
  }
  return parts.join(" — ") || undefined;
}

function extractTopicsFromDetections(detections, captions) {
  const topics = new Set();
  for (const d of detections) {
    topics.add(d.label.toLowerCase());
  }
  for (const c of captions) {
    for (const tag of c.tags ?? []) {
      topics.add(tag.toLowerCase());
    }
  }
  return [...topics].slice(0, 8);
}

function applyContextOverrides(entry, contextOverrides, clipId) {
  const override = contextOverrides[clipId];
  if (!override) {
    return entry;
  }
  return {
    ...entry,
    clipRole: override.clipRole ?? entry.clipRole,
    roleConfidence: override.roleConfidence ?? entry.roleConfidence,
    roleSource: "context_override",
    excludeFromMainStory: override.excludeFromMainStory ?? entry.excludeFromMainStory,
    excludeReason: override.excludeReason ?? entry.excludeReason,
  };
}

function loadClipAudioTags(workDir, clipId) {
  const audioPath = path.join(workDir, ARTIFACTS.audioAnalysis(clipId));
  if (!fs.existsSync(audioPath)) {
    return [];
  }
  const analysis = readJson(audioPath);
  return topEditorialTagNames(analysis.editorialTags ?? []);
}

function mergeTopics(visualTopics, audioTags, l1Topics = []) {
  const merged = new Set();
  for (const topic of visualTopics ?? []) {
    merged.add(topic.toLowerCase());
  }
  for (const tag of audioTags ?? []) {
    merged.add(tag.toLowerCase());
  }
  for (const topic of l1Topics ?? []) {
    merged.add(topic.toLowerCase());
  }
  return [...merged].slice(0, 10);
}

function aggregateL1ForClip(clipId, abstraction, timelineIndex) {
  const scenes = (timelineIndex.scenes ?? []).filter((scene) => scene.clipId === clipId);
  const l1Entries = scenes
    .map((scene) => (abstraction.L1 ?? []).find((entry) => entry.sceneId === scene.sceneId))
    .filter(Boolean);

  if (l1Entries.length === 0) {
    return null;
  }

  const brollValues = l1Entries.map((entry) => entry.brollPotential ?? 0);
  const avgBrollPotential = brollValues.reduce((sum, value) => sum + value, 0) / brollValues.length;

  return {
    sceneCount: l1Entries.length,
    speechSceneCount: scenes.filter((scene) => scene.hasSpeech).length,
    avgBrollPotential,
    maxBrollPotential: Math.max(...brollValues),
    topics: [...new Set(l1Entries.flatMap((entry) => entry.topics ?? []))],
    isNarrationSource: l1Entries.some((entry) => entry.isNarrationSource === true),
    dominantMood: l1Entries.find((entry) => entry.mood)?.mood,
  };
}

function refineClipEntryFromL1(entry, l1Agg, timelineIndex) {
  if (!l1Agg || entry.roleSource === "context_override") {
    return entry;
  }

  const clipScenes = (timelineIndex.scenes ?? []).filter((scene) => scene.clipId === entry.clipId);
  let clipRole = entry.clipRole;
  let roleConfidence = entry.roleConfidence ?? 0.5;
  let roleSource = entry.roleSource ?? "clip_profile";
  let excludeFromMainStory = entry.excludeFromMainStory ?? false;
  let excludeReason = entry.excludeReason ?? null;
  let changed = false;

  if (l1Agg.isNarrationSource && entry.hasSpeech) {
    clipRole = "narration_track";
    roleConfidence = Math.max(roleConfidence, 0.9);
    changed = true;
  } else if (
    l1Agg.speechSceneCount === 0
    && l1Agg.avgBrollPotential >= 0.65
    && clipRole !== "narration_track"
  ) {
    clipRole = "broll_pool";
    roleConfidence = Math.max(roleConfidence, 0.8);
    changed = true;
  } else if (
    entry.speechWordCount < 5
    && !entry.hasSpeech
    && l1Agg.avgBrollPotential >= 0.55
    && clipRole !== "narration_track"
  ) {
    clipRole = "broll_pool";
    roleConfidence = Math.max(roleConfidence, 0.75);
    changed = true;
  } else if (
    entry.hasSpeech
    && entry.speechWordCount >= 20
    && l1Agg.avgBrollPotential < 0.35
    && l1Agg.speechSceneCount > 0
    && clipRole !== "narration_track"
  ) {
    clipRole = "aroll_primary";
    roleConfidence = Math.max(roleConfidence, 0.82);
    changed = true;
  } else if (clipRole === "undecided") {
    clipRole = entry.hasSpeech ? "aroll_secondary" : "broll_pool";
    roleConfidence = 0.65;
    changed = true;
  }

  if (clipRole === "outtakes") {
    excludeFromMainStory = true;
    excludeReason = excludeReason ?? "Wysoki filler ratio i niska stabilność";
  }

  const mergedTopics = mergeTopics(entry.topics, entry.audioTags, l1Agg.topics);

  if (!changed && mergedTopics.join(",") === (entry.topics ?? []).join(",")) {
    return entry;
  }

  return {
    ...entry,
    clipRole,
    roleConfidence,
    roleSource: changed ? "l1_refined" : roleSource,
    topics: mergedTopics.length > 0 ? mergedTopics : entry.topics,
    excludeFromMainStory,
    excludeReason,
    ...(l1Agg.dominantMood ? { l1DominantMood: l1Agg.dominantMood } : {}),
    ...(l1Agg.avgBrollPotential != null
      ? { l1AvgBrollPotential: Math.round(l1Agg.avgBrollPotential * 100) / 100 }
      : {}),
  };
}

/**
 * Post-L1 pass: adjust clip roles/topics using summarizer scene understanding.
 */
export function refineClipRegistryFromL1(clipRegistry, abstraction, timelineIndex) {
  return (clipRegistry ?? []).map((entry) => {
    const l1Agg = aggregateL1ForClip(entry.clipId, abstraction, timelineIndex);
    return refineClipEntryFromL1(entry, l1Agg, timelineIndex);
  });
}

export async function runClipRegistryRefineStep({ workDir }) {
  const outPath = path.join(workDir, ARTIFACTS.clipRegistry);
  const artifact = readJson(outPath);
  const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
  const timelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
  const clipRegistry = refineClipRegistryFromL1(
    artifact.clipRegistry ?? artifact,
    abstraction,
    timelineIndex,
  );

  const updated = ClipRegistryArtifactSchema.parse({
    version: "1.0",
    batchId: artifact.batchId ?? timelineIndex.batchId,
    clipRegistry,
  });
  writeJson(outPath, updated);
  return updated;
}

export function buildClipRegistry(timelineIndex, catalog, { userContext = "", workDir = null } = {}) {
  const context = parseBatchContextFromUserContext(userContext);
  const contextOverrides = context.clipOverrides ?? {};

  const wordCounts = catalog.clips.map((clip) => {
    const words = timelineIndex.words.filter((w) => w.wordId.startsWith(`${clip.clipId}_`));
    return words.length;
  });
  const sorted = [...wordCounts].sort((a, b) => a - b);
  const medianWordCount = sorted.length > 0
    ? sorted[Math.floor(sorted.length / 2)]
    : 0;

  const clipRegistry = catalog.clips.map((clip, sortIndex) => {
    const stats = computeClipStats(clip, timelineIndex);
    const { clipRole, roleConfidence } = assignClipRole(stats, medianWordCount, clip);

    const visualTopics = extractTopicsFromDetections(stats.detections, stats.captions);
    const audioTags = workDir ? loadClipAudioTags(workDir, clip.clipId) : [];

    let entry = {
      clipId: clip.clipId,
      fileName: clip.fileName ?? path.basename(clip.sourcePath ?? `${clip.clipId}.mp4`),
      durationSec: clip.durationSec,
      sortIndex,
      ...(clip.creationTime ? { creationTime: clip.creationTime } : {}),
      clipRole,
      roleConfidence,
      roleSource: "clip_profile",
      hasSpeech: stats.hasSpeech,
      speechWordCount: stats.speechWordCount,
      ...(clip.mediaType ? { mediaType: clip.mediaType } : {}),
      visualSummary: buildVisualSummary(stats),
      topics: mergeTopics(visualTopics, audioTags),
      audioTags: audioTags.length ? audioTags : undefined,
      visualQuality: stats.visualQuality,
      excludeFromMainStory: clipRole === "outtakes",
      excludeReason: clipRole === "outtakes" ? "Wysoki filler ratio i niska stabilność" : null,
    };

    entry = applyContextOverrides(entry, contextOverrides, clip.clipId);
    return entry;
  });

  return clipRegistry;
}

export async function runClipProfileStep({ workDir, userContext = "", force = false }) {
  const outPath = path.join(workDir, ARTIFACTS.clipRegistry);
  if (shouldUseCachedArtifact(workDir, ARTIFACTS.clipRegistry, force)) {
    return readJson(outPath);
  }

  const timelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));

  const clipRegistry = buildClipRegistry(timelineIndex, catalog, { userContext, workDir });

  const artifact = ClipRegistryArtifactSchema.parse({
    version: "1.0",
    batchId: timelineIndex.batchId,
    clipRegistry,
  });

  writeJson(outPath, artifact);
  return artifact;
}
