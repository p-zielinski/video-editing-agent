import path from "node:path";
import { buildTimelineIndex } from "../../lib/timeline-index.js";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";

export async function runIndexStep({ workDir, userContext = "", force = false }) {
  const indexPath = path.join(workDir, ARTIFACTS.timelineIndex);
  if (shouldUseCachedArtifact(workDir, ARTIFACTS.timelineIndex, force)) {
    return readJson(indexPath);
  }

  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const manifest = readJson(path.join(workDir, ARTIFACTS.manifest));

  const wordIndexes = catalog.clips.map((clip) =>
    readJson(path.join(workDir, ARTIFACTS.words(clip.clipId))),
  );

  const keyframeSets = catalog.clips.map((clip) => {
    const p = path.join(workDir, ARTIFACTS.keyframes(clip.clipId));
    try {
      return readJson(p);
    } catch {
      return { keyframes: [] };
    }
  });

  const visionSets = catalog.clips.map((clip) => {
    const p = path.join(workDir, ARTIFACTS.vision(clip.clipId));
    try {
      return readJson(p);
    } catch {
      return { captions: [] };
    }
  });

  const objectSets = catalog.clips.map((clip) => {
    const p = path.join(workDir, ARTIFACTS.objects(clip.clipId));
    try {
      return readJson(p);
    } catch {
      return { detections: [] };
    }
  });

  const index = buildTimelineIndex({
    batchId: catalog.batchId,
    catalog,
    wordIndexes,
    keyframeSets,
    visionSets,
    objectSets,
    userContext: userContext || manifest.userContext || "",
  });

  writeJson(indexPath, index);

  const enrichedCatalog = {
    ...catalog,
    scenes: index.scenes,
  };
  writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), enrichedCatalog);

  return index;
}
