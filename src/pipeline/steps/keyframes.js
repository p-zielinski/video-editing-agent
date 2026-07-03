import fs from "node:fs";
import path from "node:path";
import { extractFrameAt } from "../../lib/ffmpeg.js";
import { writeJson, readJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact } from "../artifact-deps.js";

export const DEFAULT_MAX_FRAMES_PER_MIN = 6;
export const BROLL_MAX_FRAMES_PER_MIN = 12;
const SPEECH_WINDOW_SEC = 2;
const MOTION_DURATION_DELTA_SEC = 5;
const MOTION_CUT_SCORE_THRESHOLD = 0.35;

/**
 * Hybrydowy sampling: scene cuts + gęstszy przy mowie (±2s) + ruch (delta scen), z limitem klatek/min.
 */
export function planHybridKeyframes({
  scenes,
  words,
  clipId,
  maxFramesPerMin = DEFAULT_MAX_FRAMES_PER_MIN,
  durationSec,
  motionThresholdSec = MOTION_DURATION_DELTA_SEC,
}) {
  const candidates = new Map();
  const clipScenes = scenes
    .filter((s) => s.clipId === clipId)
    .sort((a, b) => a.startSec - b.startSec);

  function addCandidate(timestampSec, sceneId, trigger) {
    const clamped = Math.max(0, Math.min(durationSec, timestampSec));
    const key = clamped.toFixed(2);
    const existing = candidates.get(key);
    if (!existing || triggerPriority(trigger) > triggerPriority(existing.trigger)) {
      candidates.set(key, { timestampSec: clamped, sceneId, trigger });
    }
  }

  for (const scene of clipScenes) {
    const mid = (scene.startSec + scene.endSec) / 2;
    addCandidate(scene.startSec, scene.sceneId, "scene_cut");
    if (scene.durationSec > 4) {
      addCandidate(mid, scene.sceneId, "scene_cut");
    }
  }

  for (let i = 1; i < clipScenes.length; i += 1) {
    const prev = clipScenes[i - 1];
    const curr = clipScenes[i];
    const durationDelta = Math.abs(curr.durationSec - prev.durationSec);
    const boundaryGap = curr.startSec - prev.endSec;
    const cutScore = curr.cutScore ?? 0;
    const highMotionScore = cutScore >= MOTION_CUT_SCORE_THRESHOLD;
    const hasBoundaryGap = boundaryGap > 0.05;

    if (highMotionScore || hasBoundaryGap || durationDelta >= motionThresholdSec) {
      addCandidate(curr.startSec, curr.sceneId, "motion");
      if (curr.durationSec > 2) {
        addCandidate((curr.startSec + curr.endSec) / 2, curr.sceneId, "motion");
      }
    }
  }

  const speechTs = speechTimestampsFromWords(words, SPEECH_WINDOW_SEC);
  for (const ts of speechTs) {
    addCandidate(ts, findSceneAt(scenes, ts, clipId), "speech");
  }

  const sorted = [...candidates.values()].sort((a, b) => a.timestampSec - b.timestampSec);
  const maxFrames = Math.ceil((durationSec / 60) * maxFramesPerMin);
  return thinKeyframes(sorted, maxFrames, durationSec);
}

function triggerPriority(trigger) {
  if (trigger === "speech") {
    return 3;
  }
  if (trigger === "motion") {
    return 2;
  }
  return 1;
}

function findSceneAt(scenes, timestampSec, clipId) {
  const match = scenes.find(
    (s) => s.clipId === clipId && timestampSec >= s.startSec && timestampSec < s.endSec,
  );
  return match?.sceneId ?? `${clipId}_scene001`;
}

function thinKeyframes(keyframes, maxFrames, durationSec) {
  if (keyframes.length <= maxFrames) {
    return keyframes;
  }

  const result = [];
  const minGapSec = (durationSec / maxFrames) * 0.8;

  for (const frame of keyframes) {
    const last = result.at(-1);
    if (!last || frame.timestampSec - last.timestampSec >= minGapSec) {
      result.push(frame);
    } else if (frame.trigger === "speech" && last.trigger !== "speech") {
      result[result.length - 1] = frame;
    }
  }

  if (result.length > maxFrames) {
    const step = result.length / maxFrames;
    const thinned = [];
    for (let i = 0; i < maxFrames; i += 1) {
      thinned.push(result[Math.floor(i * step)]);
    }
    return thinned;
  }

  return result;
}

export function speechTimestampsFromWords(words, windowSec = SPEECH_WINDOW_SEC) {
  if (words.length === 0) {
    return [];
  }

  const timestamps = new Set();
  for (const word of words) {
    timestamps.add(word.start);
    timestamps.add(Math.max(0, word.start - windowSec));
    timestamps.add(word.start + windowSec);
  }
  return [...timestamps].sort((a, b) => a - b);
}

function loadClipRegistryEntries(workDir) {
  const registryPath = path.join(workDir, ARTIFACTS.clipRegistry);
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const data = readJson(registryPath);
  return data.clipRegistry ?? data;
}

/**
 * Higher keyframe density for B-roll pool clips and clips without speech.
 */
export function resolveMaxFramesPerMin({ clipEntry, words = [] }) {
  if (clipEntry?.clipRole === "broll_pool") {
    return BROLL_MAX_FRAMES_PER_MIN;
  }
  const hasSpeech = clipEntry?.hasSpeech ?? words.length > 0;
  if (!hasSpeech) {
    return BROLL_MAX_FRAMES_PER_MIN;
  }
  return DEFAULT_MAX_FRAMES_PER_MIN;
}

export async function runKeyframesStep({ workDir, extractImages = true, force = false }) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const clipRegistry = loadClipRegistryEntries(workDir);
  const allKeyframes = [];

  for (const clip of catalog.clips) {
    const outPath = path.join(workDir, ARTIFACTS.keyframes(clip.clipId));
    if (force) {
      removeClipArtifact(outPath);
    }
    if (shouldUseCachedClipArtifact(workDir, outPath, force)) {
      allKeyframes.push(readJson(outPath));
      continue;
    }

    if (clip.mediaType === "audio_only") {
      const payload = {
        version: "1.0",
        clipId: clip.clipId,
        keyframes: [],
      };
      writeJson(outPath, payload);
      allKeyframes.push(payload);
      continue;
    }

    const wordIndex = readJson(path.join(workDir, ARTIFACTS.words(clip.clipId)));
    const scenes = catalog.scenes.filter((s) => s.clipId === clip.clipId);
    const clipEntry = clipRegistry.find((entry) => entry.clipId === clip.clipId);
    const maxFramesPerMin = resolveMaxFramesPerMin({
      clipEntry,
      words: wordIndex.words,
    });

    const planned = planHybridKeyframes({
      scenes,
      words: wordIndex.words,
      clipId: clip.clipId,
      durationSec: clip.durationSec,
      maxFramesPerMin,
    });

    const framesDir = path.join(workDir, "frames", clip.clipId);
    if (extractImages) {
      fs.mkdirSync(framesDir, { recursive: true });
    }

    const keyframes = [];
    for (let i = 0; i < planned.length; i += 1) {
      const frame = planned[i];
      let imagePath;

      if (extractImages) {
        imagePath = path.join(framesDir, `frame-${String(i).padStart(4, "0")}.jpg`);
        await extractFrameAt(clip.sourcePath, frame.timestampSec, imagePath);
      }

      keyframes.push({
        ...frame,
        imagePath: imagePath ? path.relative(workDir, imagePath) : undefined,
      });
    }

    const payload = {
      version: "1.0",
      clipId: clip.clipId,
      keyframes,
    };

    writeJson(outPath, payload);
    allKeyframes.push(payload);
  }

  return allKeyframes;
}
