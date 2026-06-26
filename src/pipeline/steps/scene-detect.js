import path from "node:path";
import { runPythonScript } from "../../lib/python-bridge.js";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";

export async function runSceneDetectionForClip(clip, { stub = false } = {}) {
  if (stub) {
    return [{ startSec: 0, endSec: clip.durationSec }];
  }

  const result = await runPythonScript("scene_detect.py", {
    videoPath: clip.sourcePath,
    threshold: 0.3,
  });

  return result.scenes ?? [];
}

export async function detectScenesForCatalog(catalog, { stub = false } = {}) {
  const byClip = new Map();

  for (const clip of catalog.clips) {
    const scenes = await runSceneDetectionForClip(clip, { stub });
    byClip.set(clip.clipId, scenes);
  }

  return byClip;
}
