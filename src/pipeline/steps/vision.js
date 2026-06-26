import path from "node:path";
import { runPythonScript } from "../../lib/python-bridge.js";
import { readJson, writeJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact } from "../artifact-deps.js";

export async function runVisionStep({ workDir, stub = true, force = false }) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const results = [];

  for (const clip of catalog.clips) {
    const outPath = path.join(workDir, ARTIFACTS.vision(clip.clipId));
    if (force) {
      removeClipArtifact(outPath);
    }
    if (shouldUseCachedClipArtifact(workDir, outPath, force)) {
      results.push(readJson(outPath));
      continue;
    }

    const keyframes = readJson(path.join(workDir, ARTIFACTS.keyframes(clip.clipId)));
    const frames = (keyframes.keyframes ?? [])
      .filter((kf) => kf.imagePath)
      .map((kf) => ({
        imagePath: path.join(workDir, kf.imagePath),
        timestampSec: kf.timestampSec,
        sceneId: kf.sceneId,
      }));

    const result = await runPythonScript("vision_qwen.py", {
      frames,
      stub: stub || frames.length === 0,
    });

    const payload = {
      version: "1.0",
      clipId: clip.clipId,
      captions: result.captions ?? [],
    };

    writeJson(outPath, payload);
    results.push(payload);
  }

  return results;
}

export async function runObjectsStep({ workDir, stub = true, enabled = true, force = false }) {
  if (!enabled) {
    return [];
  }

  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const results = [];

  for (const clip of catalog.clips) {
    const outPath = path.join(workDir, ARTIFACTS.objects(clip.clipId));
    if (force) {
      removeClipArtifact(outPath);
    }
    if (shouldUseCachedClipArtifact(workDir, outPath, force)) {
      results.push(readJson(outPath));
      continue;
    }

    const keyframes = readJson(path.join(workDir, ARTIFACTS.keyframes(clip.clipId)));
    const frames = (keyframes.keyframes ?? [])
      .filter((kf) => kf.imagePath)
      .map((kf) => ({
        imagePath: path.join(workDir, kf.imagePath),
        timestampSec: kf.timestampSec,
        sceneId: kf.sceneId,
      }));

    const result = await runPythonScript("vision_florence.py", {
      frames,
      stub,
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
