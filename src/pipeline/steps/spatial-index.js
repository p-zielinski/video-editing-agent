import fs from "node:fs";
import path from "node:path";
import { deriveClipIdFromSceneId } from "../../editorial/spatial-ref.js";
import { SpatialIndexSchema } from "../../schemas/spatial-index.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";
import {
  collectFaceDetections,
  runFaceDetectStep,
  loadCatalogForFaceDetect,
} from "./face-detect.js";

export function collectObjectDetections(workDir, catalog) {
  const detections = [];
  for (const clip of catalog.clips ?? []) {
    const objectsPath = path.join(workDir, ARTIFACTS.objects(clip.clipId));
    try {
      const data = readJson(objectsPath);
      detections.push(...(data.detections ?? []));
    } catch {
      // Object detections are optional per clip.
    }
  }
  return detections;
}

const FACE_LABELS = new Set(["face", "head", "human face"]);
const SUBJECT_LABELS = new Set([
  "person",
  "human",
  "man",
  "woman",
  "boy",
  "girl",
  "people",
  "adult",
  "child",
]);

function mapLabelToAnchorType(label, detectionType) {
  if (detectionType === "face") {
    return "face";
  }

  const normalized = String(label ?? "").toLowerCase().trim();
  if (!normalized) {
    return "object";
  }
  if (FACE_LABELS.has(normalized) || normalized.includes("face")) {
    return "face";
  }
  if (
    SUBJECT_LABELS.has(normalized)
    || normalized.includes("person")
    || normalized.includes("human")
  ) {
    return "subject";
  }
  return "object";
}

function detectionScore(detection) {
  const type = mapLabelToAnchorType(detection.label, detection.type);
  const confidence = detection.confidence ?? 0.5;
  const typeBoost = type === "face" ? 0.05 : type === "subject" ? 0.03 : 0;
  return confidence + typeBoost;
}

function isNormalizedBbox(bbox) {
  return bbox.every((value) => value >= 0 && value <= 1);
}

function looksLikePixelBbox(bbox) {
  return bbox.some((value) => value > 1);
}

/**
 * Normalize bbox to [x, y, w, h] in 0–1 space.
 * Accepts pixel coords (x,y,w,h) or (x1,y1,x2,y2) when dimensions are known.
 */
export function normalizeBbox(bbox, dimensions) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return null;
  }

  const values = bbox.map((value) => Number(value));
  if (values.some((value) => Number.isNaN(value))) {
    return null;
  }

  if (isNormalizedBbox(values)) {
    return values;
  }

  if (!looksLikePixelBbox(values)) {
    return values;
  }

  const width = dimensions?.width ?? dimensions?.w;
  const height = dimensions?.height ?? dimensions?.h;
  if (!width || !height) {
    return null;
  }

  const [a, b, c, d] = values;

  const fitsPixelXywh = a + c <= width + 1 && b + d <= height + 1;
  if (fitsPixelXywh) {
    return [a / width, b / height, c / width, d / height];
  }

  if (c > a && d > b) {
    return [
      a / width,
      b / height,
      (c - a) / width,
      (d - b) / height,
    ];
  }

  return [a / width, b / height, c / width, d / height];
}

function getSceneDimensions(scene, timelineIndex) {
  if (scene?.resolution?.w && scene?.resolution?.h) {
    return { width: scene.resolution.w, height: scene.resolution.h };
  }

  const clip = (timelineIndex?.clips ?? []).find((entry) => entry.clipId === scene?.clipId);
  if (clip?.resolution?.w && clip?.resolution?.h) {
    return { width: clip.resolution.w, height: clip.resolution.h };
  }

  return null;
}

function normalizeDetectionBbox(detection, scene, timelineIndex) {
  if (!Array.isArray(detection.bbox) || detection.bbox.length !== 4) {
    return null;
  }

  const dimensions = getSceneDimensions(scene, timelineIndex);
  return normalizeBbox(detection.bbox, dimensions);
}

function toAnchor(detection, scene, timelineIndex) {
  const bbox = normalizeDetectionBbox(detection, scene, timelineIndex);
  if (!bbox) {
    return null;
  }

  const type = mapLabelToAnchorType(detection.label, detection.type);
  return {
    type,
    bbox,
    timestampSec: detection.timestampSec,
    label: detection.label ?? type,
    confidence: detection.confidence ?? 0.5,
  };
}

function bestDetection(detections, type, scene, timelineIndex) {
  const pool = detections.filter((d) => mapLabelToAnchorType(d.label, d.type) === type);
  if (pool.length === 0) {
    return null;
  }

  const sorted = [...pool].sort((a, b) => detectionScore(b) - detectionScore(a));
  return toAnchor(sorted[0], scene, timelineIndex);
}

export function buildSceneAnchors(sceneId, detections, { scene, timelineIndex } = {}) {
  const sceneDetections = detections
    .filter((d) => d.sceneId === sceneId && Array.isArray(d.bbox) && d.bbox.length === 4);

  if (sceneDetections.length === 0) {
    return [];
  }

  const anchors = [];
  const faceAnchor = bestDetection(sceneDetections, "face", scene, timelineIndex);
  if (faceAnchor) {
    anchors.push(faceAnchor);
  }

  const subjectAnchor = bestDetection(sceneDetections, "subject", scene, timelineIndex);
  if (subjectAnchor) {
    anchors.push(subjectAnchor);
  }

  if (anchors.length === 0) {
    const objectAnchor = bestDetection(sceneDetections, "object", scene, timelineIndex);
    if (objectAnchor) {
      anchors.push(objectAnchor);
    }
  }

  return anchors;
}

export function mergeDetections(objectDetections = [], faceDetections = []) {
  return [...objectDetections, ...faceDetections];
}

export function buildSpatialIndex(timelineIndex, { builtFrom, faceDetections = [] } = {}) {
  const detections = mergeDetections(timelineIndex.objectDetections ?? [], faceDetections);
  const scenes = (timelineIndex.scenes ?? []).map((scene) => ({
    sceneId: scene.sceneId,
    clipId: scene.clipId ?? deriveClipIdFromSceneId(scene.sceneId),
    anchors: buildSceneAnchors(scene.sceneId, detections, { scene, timelineIndex }),
  }));

  return {
    version: "1.0",
    batchId: timelineIndex.batchId,
    scenes,
    ...(builtFrom ? { builtFrom } : {}),
  };
}

export async function runSpatialIndexStep({
  workDir,
  force = false,
  faceStub = false,
  globalCacheDisabled = false,
  runFaceDetect = runFaceDetectStep,
} = {}) {
  const outPath = path.join(workDir, ARTIFACTS.spatialIndex);
  if (shouldUseCachedArtifact(workDir, ARTIFACTS.spatialIndex, force)) {
    return readJson(outPath);
  }

  const timelinePath = path.join(workDir, ARTIFACTS.timelineIndex);
  const timelineIndex = readJson(timelinePath);
  const catalog = loadCatalogForFaceDetect(workDir, null, timelineIndex);
  await runFaceDetect({
    workDir,
    catalog,
    timelineIndex,
    stub: faceStub,
    force,
    globalCacheDisabled,
  });
  const faceDetections = collectFaceDetections(workDir, catalog, timelineIndex);
  const objectDetections = collectObjectDetections(workDir, catalog);
  const timelineWithObjects = {
    ...timelineIndex,
    objectDetections: objectDetections.length > 0
      ? objectDetections
      : (timelineIndex.objectDetections ?? []),
  };
  const builtFrom = {
    timelineIndexMtime: fs.existsSync(timelinePath) ? fs.statSync(timelinePath).mtimeMs : null,
    objectDetectionCount: timelineWithObjects.objectDetections.length,
    faceDetectionCount: faceDetections.length,
  };
  const index = buildSpatialIndex(timelineWithObjects, { builtFrom, faceDetections });
  const parsed = SpatialIndexSchema.parse(index);
  writeJson(outPath, parsed);
  return parsed;
}
