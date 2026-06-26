import path from "node:path";
import fs from "node:fs";
import { runPythonScript } from "../../lib/python-bridge.js";
import { readJson, writeJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact } from "../artifact-deps.js";

export function loadCatalogForFaceDetect(workDir, catalog, timelineIndex) {
  if (catalog) {
    return catalog;
  }

  const catalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);
  if (fs.existsSync(catalogPath)) {
    return readJson(catalogPath);
  }

  if (!timelineIndex) {
    const timelinePath = path.join(workDir, ARTIFACTS.timelineIndex);
    if (fs.existsSync(timelinePath)) {
      timelineIndex = readJson(timelinePath);
    } else {
      return { clips: [] };
    }
  }

  const clipIds = new Set();
  for (const clip of timelineIndex.clips ?? []) {
    clipIds.add(clip.clipId);
  }
  for (const scene of timelineIndex.scenes ?? []) {
    if (scene.clipId) {
      clipIds.add(scene.clipId);
    }
  }

  return {
    batchId: timelineIndex.batchId,
    clips: [...clipIds].map((clipId) => ({ clipId })),
  };
}

export async function runFaceDetectStep({
  workDir,
  catalog,
  timelineIndex,
  stub = true,
  force = false,
}) {
  const resolvedCatalog = loadCatalogForFaceDetect(workDir, catalog, timelineIndex);
  const results = [];

  for (const clip of resolvedCatalog.clips) {
    const outPath = path.join(workDir, ARTIFACTS.faces(clip.clipId));
    if (force) {
      removeClipArtifact(outPath);
    }
    if (shouldUseCachedClipArtifact(workDir, outPath, force)) {
      results.push(readJson(outPath));
      continue;
    }

    const keyframesPath = path.join(workDir, ARTIFACTS.keyframes(clip.clipId));
    let frames = [];
    try {
      const keyframes = readJson(keyframesPath);
      frames = (keyframes.keyframes ?? [])
        .filter((kf) => kf.imagePath)
        .map((kf) => ({
          imagePath: path.join(workDir, kf.imagePath),
          timestampSec: kf.timestampSec,
          sceneId: kf.sceneId,
        }));
    } catch {
      frames = [];
    }

    const result = await runPythonScript("face_detect.py", {
      frames,
      stub: stub || frames.length === 0,
    });

    const payload = {
      version: "1.0",
      clipId: clip.clipId,
      detections: result.detections ?? [],
    };

    writeJson(outPath, payload);
    results.push(payload);
  }

  return results;
}

export function collectFaceDetections(workDir, catalog, timelineIndex) {
  const resolvedCatalog = loadCatalogForFaceDetect(workDir, catalog, timelineIndex);
  const detections = [];
  for (const clip of resolvedCatalog.clips) {
    const facePath = path.join(workDir, ARTIFACTS.faces(clip.clipId));
    try {
      const data = readJson(facePath);
      detections.push(...(data.detections ?? []));
    } catch {
      // Face detect is optional — missing artifacts are OK.
    }
  }
  return detections;
}
