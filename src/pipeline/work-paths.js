import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const PIPELINE_STEPS = [
  "ingest",
  "transcribe",
  "audio_analysis",
  "keyframes",
  "twelvelabs",
  "vision",
  "objects",
  "index",
  "clip_profile",
  "abstract",
  "topic_index",
  "spatial_index",
  "direct",
  "review",
  "thumbnails",
];

export const PIPELINE_STEP_COUNT = PIPELINE_STEPS.length;

export const ARTIFACTS = {
  manifest: "00-manifest.json",
  sceneCatalog: "00-scene-catalog.json",
  words: (clipId) => `01-words-${clipId}.json`,
  audioAnalysis: (clipId) => `01b-audio-analysis-${clipId}.json`,
  keyframes: (clipId) => `02-keyframes-${clipId}.json`,
  twelvelabs: (clipId) => `03b-twelvelabs-${clipId}.json`,
  vision: (clipId) => `03-vision-${clipId}.json`,
  objects: (clipId) => `04-objects-${clipId}.json`,
  faces: (clipId) => `04a-faces-${clipId}.json`,
  timelineIndex: "05-timeline-index.json",
  clipRegistry: "05a-clip-registry.json",
  topicIndex: "05b-topic-index.json",
  spatialIndex: "05c-spatial-index.json",
  audioIndex: "05d-audio-index.json",
  abstraction: "06-abstract.json",
  abstractionL1: "06-abstract-L1.json",
  abstractionL2: "06-abstract-L2.json",
  abstractionL3: "06-abstract-L3.json",
  recipeDraft: "07-edit-recipe-draft.json",
  review: "08-review.json",
  recipeFinal: "09-edit-recipe-final.json",
  batchQualityReport: "10-batch-quality-report.json",
  thumbnailPlan: "11-thumbnail-plan.json",
  thumbnailReview: "12-thumbnail-review.json",
  renderManifest: "13-render-manifest.json",
  recipeProvenance: "14-recipe-provenance.json",
};

export function formatToRenderSuffix(format) {
  return format.replace(":", "x");
}

export function renderOutputPath(workDir, outputId, format) {
  const suffix = formatToRenderSuffix(format);
  return path.join(workDir, "renders", `${outputId}_${suffix}.mp4`);
}

export function renderTmpDir(workDir, outputId) {
  return path.join(workDir, "renders", ".tmp", outputId);
}

export function thumbnailImagePath(workDir, outputId, variantId) {
  return path.join(workDir, "thumbnails", outputId, `${variantId}.png`);
}

export function createBatchId() {
  return randomUUID().slice(0, 8);
}

export function resolveWorkDir(batchId, baseDir = "output/.work") {
  return path.resolve(baseDir, batchId);
}

export function artifactPath(workDir, name) {
  return path.join(workDir, name);
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function artifactExists(workDir, name) {
  return fs.existsSync(artifactPath(workDir, name));
}

export function validatePipelineStep(step, flagName = "step") {
  if (!PIPELINE_STEPS.includes(step)) {
    return `${flagName} musi być jednym z: ${PIPELINE_STEPS.join("|")}`;
  }
  return null;
}

export function stepIndex(step) {
  const index = PIPELINE_STEPS.indexOf(step);
  if (index === -1) {
    throw new Error(`Nieznany krok pipeline: ${step}`);
  }
  return index;
}

export function shouldRunStep(step, fromStep, toStep) {
  if (fromStep && stepIndex(step) < stepIndex(fromStep)) {
    return false;
  }
  if (toStep && stepIndex(step) > stepIndex(toStep)) {
    return false;
  }
  return true;
}

export function shouldSkipArtifact(workDir, artifactName, force = false) {
  return !force && artifactExists(workDir, artifactName);
}

/** @deprecated Import shouldUseCachedClipArtifact from artifact-deps.js */
export function shouldUseCachedClipArtifact(workDirOrOutPath, outPathOrForce, force = false) {
  if (typeof outPathOrForce === "boolean") {
    return !outPathOrForce && fs.existsSync(workDirOrOutPath);
  }
  return !force && fs.existsSync(outPathOrForce);
}

export function removeClipArtifact(outPath) {
  if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
  }
}
