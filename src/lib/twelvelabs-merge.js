import path from "node:path";
import fs from "node:fs";
import { readJson, ARTIFACTS } from "../pipeline/work-paths.js";

export function loadTwelveLabsByClip(workDir, clipId) {
  const artifactPath = path.join(workDir, ARTIFACTS.twelvelabs(clipId));
  if (!fs.existsSync(artifactPath)) {
    return null;
  }
  return readJson(artifactPath);
}

function momentOverlapsScene(moment, scene) {
  const start = moment.startSec ?? 0;
  const end = moment.endSec ?? start;
  const sceneStart = scene.startSec ?? 0;
  const sceneEnd = scene.endSec ?? sceneStart;
  return start < sceneEnd && end > sceneStart;
}

export function mergeTwelveLabsIntoVisualText(qwenCaptions, tlMoments, scene, tlArtifact = null) {
  const captionParts = (qwenCaptions ?? []).flatMap((entry) => [
    entry.caption,
    ...(entry.tags ?? []),
  ]);

  const relevantMoments = (tlMoments ?? []).filter((moment) => momentOverlapsScene(moment, scene));
  const momentParts = relevantMoments.flatMap((moment) => [
    moment.description,
    moment.summary,
    moment.editUse ? `edit:${moment.editUse}` : null,
    ...(moment.tags ?? []),
  ].filter(Boolean));

  const editorialParts = [
    tlArtifact?.editorial?.summary,
    tlArtifact?.editorial?.mood ? `mood:${tlArtifact.editorial.mood}` : null,
    ...(tlArtifact?.editorial?.editingHints ?? []),
    ...(tlArtifact?.gist?.topics ?? []),
  ].filter(Boolean);

  return [...captionParts, ...momentParts, ...editorialParts].filter(Boolean).join(" ");
}
