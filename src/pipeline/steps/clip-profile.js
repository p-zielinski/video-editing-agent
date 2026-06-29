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

function mergeTopics(visualTopics, audioTags) {
  const merged = new Set();
  for (const topic of visualTopics ?? []) {
    merged.add(topic.toLowerCase());
  }
  for (const tag of audioTags ?? []) {
    merged.add(tag.toLowerCase());
  }
  return [...merged].slice(0, 10);
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
