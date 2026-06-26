import path from "node:path";
import fs from "node:fs";
import { extractAudioForAnalysis, analysisAudioPath } from "../../lib/extract-audio.js";
import { measureLoudness } from "../../lib/measure-loudness.js";
import { runPythonScript } from "../../lib/python-bridge.js";
import {
  ClipAudioAnalysisSchema,
  AudioIndexSchema,
} from "../../schemas/audio-analysis.js";
import { pickByMood, summarizeMusicLibraryForIndex } from "../../editorial/music-library.js";
import {
  enrichAudioEvents,
  rollupEditorialTags,
  topEditorialTagNames,
} from "../../editorial/audio-event-tags.js";
import { readJson, writeJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact, shouldUseCachedArtifact } from "../artifact-deps.js";

function inferMoodFromAnalysis({ estimatedBpm, silenceRatio }) {
  if (silenceRatio > 0.15) {
    return "calm";
  }
  if (Number.isFinite(estimatedBpm) && estimatedBpm >= 115) {
    return "upbeat";
  }
  return "vlog";
}

/** Prefer panns in batch rollup when any clip used PANNs SED. */
function rollupEventDetectionMode(modes) {
  const unique = [...new Set(modes.filter(Boolean))];
  if (unique.includes("panns")) {
    return "panns";
  }
  if (unique.length === 1) {
    return unique[0];
  }
  if (unique.includes("stub")) {
    return "stub";
  }
  return "none";
}

function buildClipSummary(clipId, analysis) {
  const totalSilenceSec = (analysis.silenceGaps ?? []).reduce(
    (sum, gap) => sum + (gap.durationSec ?? 0),
    0,
  );

  return {
    clipId,
    voiceLufs: analysis.voiceLufs,
    beatCount: analysis.beats?.length ?? 0,
    silenceGapCount: analysis.silenceGaps?.length ?? 0,
    totalSilenceSec: Math.round(totalSilenceSec * 1000) / 1000,
    recommendedTrackId: analysis.musicBedRecommendation?.trackId ?? null,
    estimatedBpm: analysis.estimatedBpm,
    beatTimes: (analysis.beats ?? []).map((b) => b.timeSec),
    audioEventCount: analysis.audioEvents?.length ?? 0,
    editorialTags: topEditorialTagNames(analysis.editorialTags ?? []),
    eventDetectionMode: analysis.eventDetectionMode ?? "none",
  };
}

function buildBatchSummary(clips, perClipAnalysis) {
  const voiceValues = clips
    .map((c) => c.voiceLufs)
    .filter((v) => Number.isFinite(v));

  const avgVoiceLufs = voiceValues.length
    ? Math.round((voiceValues.reduce((a, b) => a + b, 0) / voiceValues.length) * 10) / 10
    : null;

  const totalSilenceSec = clips.reduce((sum, c) => sum + (c.totalSilenceSec ?? 0), 0);
  const bpmValues = perClipAnalysis
    .map((a) => a.estimatedBpm)
    .filter((v) => Number.isFinite(v));
  const estimatedBpm = bpmValues.length
    ? Math.round(bpmValues.reduce((a, b) => a + b, 0) / bpmValues.length)
    : undefined;

  const dominantMood = inferMoodFromAnalysis({
    estimatedBpm,
    silenceRatio: totalSilenceSec / Math.max(1, perClipAnalysis.reduce((s, a) => s + a.durationSec, 0)),
  });

  return {
    avgVoiceLufs,
    totalSilenceSec: Math.round(totalSilenceSec * 1000) / 1000,
    dominantMood,
    estimatedBpm,
    clipCount: clips.length,
    eventDetectionMode: rollupEventDetectionMode(
      perClipAnalysis.map((a) => a.eventDetectionMode),
    ),
  };
}

export async function analyzeClipAudio({
  workDir,
  clip,
  stub = false,
  force = false,
}) {
  const outPath = path.join(workDir, ARTIFACTS.audioAnalysis(clip.clipId));
  if (force) {
    removeClipArtifact(outPath);
  }
  if (shouldUseCachedClipArtifact(workDir, outPath, force)) {
    return readJson(outPath);
  }

  const audioPath = analysisAudioPath(workDir, clip.clipId);
  if (!stub && !fs.existsSync(audioPath)) {
    await extractAudioForAnalysis(clip.sourcePath, audioPath);
  }

  let voiceLufs = null;
  if (!stub && fs.existsSync(audioPath)) {
    try {
      const loudness = await measureLoudness(audioPath, { targetLufs: -18 });
      voiceLufs = loudness.integratedLufs;
    } catch {
      voiceLufs = null;
    }
  }

  const useStub = stub || !fs.existsSync(audioPath);
  const pythonPayload = {
    audioPath: fs.existsSync(audioPath) ? audioPath : null,
    durationSec: clip.durationSec,
    stub: useStub,
  };

  const [pythonResult, eventResult] = await Promise.all([
    runPythonScript("audio_analyze.py", pythonPayload),
    runPythonScript("audio_events.py", pythonPayload),
  ]);

  const audioEvents = enrichAudioEvents(eventResult.audioEvents ?? []);
  const editorialTags = rollupEditorialTags(audioEvents);

  const estimatedBpm = pythonResult.estimatedBpm;
  const mood = inferMoodFromAnalysis({
    estimatedBpm,
    silenceRatio: (pythonResult.silenceGaps ?? []).length / Math.max(1, clip.durationSec / 10),
  });
  const track = pickByMood(mood, { bpm: estimatedBpm });

  const analysis = ClipAudioAnalysisSchema.parse({
    version: "1.0",
    clipId: clip.clipId,
    durationSec: clip.durationSec,
    voiceLufs,
    energyCurve: pythonResult.energyCurve ?? [],
    silenceGaps: pythonResult.silenceGaps ?? [],
    beats: pythonResult.beats ?? [],
    cutSuggestions: pythonResult.cutSuggestions ?? [],
    musicBedRecommendation: track
      ? {
        mood,
        trackId: track.trackId,
        bpm: track.bpm,
        confidence: 0.7,
      }
      : null,
    estimatedBpm,
    analysisMode: pythonResult.analysisMode ?? (stub ? "stub" : "speech_onsets"),
    audioEvents,
    editorialTags,
    eventDetectionMode: eventResult.eventDetectionMode ?? (useStub ? "stub" : "none"),
  });

  writeJson(outPath, analysis);
  return analysis;
}

export async function runAudioAnalysisStep({
  workDir,
  stub = false,
  force = false,
}) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const perClipAnalysis = [];

  for (const clip of catalog.clips) {
    const analysis = await analyzeClipAudio({ workDir, clip, stub, force });
    perClipAnalysis.push(analysis);
  }

  const clipSummaries = perClipAnalysis.map((analysis) =>
    buildClipSummary(analysis.clipId, analysis),
  );

  const indexPath = path.join(workDir, ARTIFACTS.audioIndex);
  if (!force && shouldUseCachedArtifact(workDir, ARTIFACTS.audioIndex, force)) {
    const existing = readJson(indexPath);
    const existingIds = new Set((existing.clips ?? []).map((c) => c.clipId));
    const currentIds = new Set(clipSummaries.map((c) => c.clipId));
    if (existingIds.size === currentIds.size && [...currentIds].every((id) => existingIds.has(id))) {
      return existing;
    }
  }

  const audioIndex = AudioIndexSchema.parse({
    version: "1.0",
    batchId: catalog.batchId,
    clips: clipSummaries,
    batchSummary: buildBatchSummary(clipSummaries, perClipAnalysis),
    musicLibrary: summarizeMusicLibraryForIndex(),
  });

  writeJson(indexPath, audioIndex);
  return audioIndex;
}

export function loadPerClipAudioAnalysis(workDir, clipId) {
  const filePath = path.join(workDir, ARTIFACTS.audioAnalysis(clipId));
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

export function loadPerClipAudioAnalysisForCatalog(workDir, catalog) {
  if (!catalog?.clips?.length) {
    return null;
  }

  const analyses = catalog.clips
    .map((clip) => loadPerClipAudioAnalysis(workDir, clip.clipId))
    .filter(Boolean);

  return analyses.length > 0 ? analyses : null;
}

export function loadAudioIndex(workDir) {
  const filePath = path.join(workDir, ARTIFACTS.audioIndex);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}
