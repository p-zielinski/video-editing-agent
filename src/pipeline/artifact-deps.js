import fs from "node:fs";
import path from "node:path";
import { shouldUseCachedClipArtifactExtended } from "../lib/clip-artifact-cache.js";
import { ARTIFACTS } from "./work-paths.js";

export const CLIP_ARTIFACT_PATTERNS = {
  words: "01-words-*",
  metaCommands: "01c-meta-commands-*",
  audioAnalysis: "01b-audio-analysis-*",
  keyframes: "02-keyframes-*",
  twelvelabs: "03b-twelvelabs-*",
  vision: "03-vision-*",
  objects: "04-objects-*",
  faces: "04a-faces-*",
};

const CLIP_ARTIFACT_PREFIXES = {
  [CLIP_ARTIFACT_PATTERNS.words]: "01-words-",
  [CLIP_ARTIFACT_PATTERNS.metaCommands]: "01c-meta-commands-",
  [CLIP_ARTIFACT_PATTERNS.audioAnalysis]: "01b-audio-analysis-",
  [CLIP_ARTIFACT_PATTERNS.keyframes]: "02-keyframes-",
  [CLIP_ARTIFACT_PATTERNS.twelvelabs]: "03b-twelvelabs-",
  [CLIP_ARTIFACT_PATTERNS.vision]: "03-vision-",
  [CLIP_ARTIFACT_PATTERNS.objects]: "04-objects-",
  [CLIP_ARTIFACT_PATTERNS.faces]: "04a-faces-",
};

const OBJECTS_PREFIX = "04-objects-";

/**
 * Upstream inputs for each artifact (mtime-based staleness).
 * Pattern keys (`01-words-*`) apply to all per-clip artifacts with that prefix.
 */
export const ARTIFACT_DEPENDENCY_GRAPH = {
  [ARTIFACTS.manifest]: [],
  [ARTIFACTS.sceneCatalog]: [ARTIFACTS.manifest],
  [CLIP_ARTIFACT_PATTERNS.words]: [ARTIFACTS.sceneCatalog],
  [CLIP_ARTIFACT_PATTERNS.metaCommands]: [ARTIFACTS.sceneCatalog, CLIP_ARTIFACT_PATTERNS.words],
  [CLIP_ARTIFACT_PATTERNS.audioAnalysis]: [ARTIFACTS.sceneCatalog, CLIP_ARTIFACT_PATTERNS.words],
  [CLIP_ARTIFACT_PATTERNS.keyframes]: [ARTIFACTS.sceneCatalog, CLIP_ARTIFACT_PATTERNS.words],
  [CLIP_ARTIFACT_PATTERNS.twelvelabs]: [ARTIFACTS.sceneCatalog, ARTIFACTS.manifest],
  [ARTIFACTS.audioIndex]: [
    ARTIFACTS.sceneCatalog,
    CLIP_ARTIFACT_PATTERNS.words,
    CLIP_ARTIFACT_PATTERNS.metaCommands,
    CLIP_ARTIFACT_PATTERNS.audioAnalysis,
  ],
  [CLIP_ARTIFACT_PATTERNS.vision]: [CLIP_ARTIFACT_PATTERNS.keyframes],
  [CLIP_ARTIFACT_PATTERNS.objects]: [CLIP_ARTIFACT_PATTERNS.keyframes],
  [CLIP_ARTIFACT_PATTERNS.faces]: [CLIP_ARTIFACT_PATTERNS.keyframes],
  [ARTIFACTS.timelineIndex]: [
    ARTIFACTS.sceneCatalog,
    CLIP_ARTIFACT_PATTERNS.words,
    CLIP_ARTIFACT_PATTERNS.metaCommands,
    CLIP_ARTIFACT_PATTERNS.keyframes,
    CLIP_ARTIFACT_PATTERNS.vision,
    CLIP_ARTIFACT_PATTERNS.objects,
  ],
  [ARTIFACTS.clipRegistry]: [
    ARTIFACTS.timelineIndex,
    ARTIFACTS.sceneCatalog,
    CLIP_ARTIFACT_PATTERNS.audioAnalysis,
    ARTIFACTS.audioIndex,
  ],
  [ARTIFACTS.abstraction]: [ARTIFACTS.timelineIndex, ARTIFACTS.clipRegistry],
  [ARTIFACTS.abstractionL1]: [ARTIFACTS.timelineIndex, ARTIFACTS.clipRegistry],
  [ARTIFACTS.abstractionL2]: [ARTIFACTS.timelineIndex, ARTIFACTS.clipRegistry],
  [ARTIFACTS.abstractionL3]: [ARTIFACTS.timelineIndex, ARTIFACTS.clipRegistry],
  [ARTIFACTS.topicIndex]: [
    ARTIFACTS.abstraction,
    ARTIFACTS.timelineIndex,
    ARTIFACTS.clipRegistry,
    CLIP_ARTIFACT_PATTERNS.objects,
    CLIP_ARTIFACT_PATTERNS.twelvelabs,
  ],
  [ARTIFACTS.spatialIndex]: [
    ARTIFACTS.timelineIndex,
    CLIP_ARTIFACT_PATTERNS.objects,
    CLIP_ARTIFACT_PATTERNS.faces,
  ],
  [ARTIFACTS.aiVideo]: [
    ARTIFACTS.spatialIndex,
    ARTIFACTS.abstraction,
    ARTIFACTS.timelineIndex,
    ARTIFACTS.sceneCatalog,
    ARTIFACTS.audioIndex,
  ],
  [ARTIFACTS.recipeDraft]: [
    ARTIFACTS.timelineIndex,
    ARTIFACTS.abstraction,
    ARTIFACTS.clipRegistry,
    ARTIFACTS.topicIndex,
    ARTIFACTS.spatialIndex,
    ARTIFACTS.audioIndex,
    ARTIFACTS.aiVideo,
    CLIP_ARTIFACT_PATTERNS.metaCommands,
  ],
  [ARTIFACTS.review]: [
    ARTIFACTS.recipeDraft,
    ARTIFACTS.abstraction,
    ARTIFACTS.timelineIndex,
    ARTIFACTS.topicIndex,
    ARTIFACTS.spatialIndex,
    ARTIFACTS.sceneCatalog,
    ARTIFACTS.audioIndex,
    CLIP_ARTIFACT_PATTERNS.words,
    CLIP_ARTIFACT_PATTERNS.metaCommands,
  ],
  [ARTIFACTS.recipeFinal]: [ARTIFACTS.review, ARTIFACTS.recipeDraft],
  [ARTIFACTS.gptUsage]: [
    ARTIFACTS.recipeDraft,
    ARTIFACTS.review,
    ARTIFACTS.recipeFinal,
  ],
  [ARTIFACTS.thumbnailPlan]: [
    ARTIFACTS.recipeFinal,
    ARTIFACTS.timelineIndex,
    ARTIFACTS.abstraction,
    ARTIFACTS.spatialIndex,
    ARTIFACTS.audioIndex,
    ARTIFACTS.manifest,
  ],
  [ARTIFACTS.thumbnailReview]: [ARTIFACTS.thumbnailPlan, ARTIFACTS.recipeFinal, ARTIFACTS.abstraction],
  "15-publish-package-*": [
    ARTIFACTS.recipeFinal,
    ARTIFACTS.thumbnailPlan,
    ARTIFACTS.renderManifest,
    ARTIFACTS.topicIndex,
    ARTIFACTS.abstraction,
  ],
  [ARTIFACTS.batchQualityReport]: [
    ARTIFACTS.timelineIndex,
    ARTIFACTS.spatialIndex,
    ARTIFACTS.audioIndex,
    ARTIFACTS.abstraction,
    ARTIFACTS.topicIndex,
    ARTIFACTS.clipRegistry,
    ARTIFACTS.recipeDraft,
    ARTIFACTS.recipeFinal,
    ARTIFACTS.review,
  ],
};

/** @deprecated Use ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.spatialIndex] */
export const SPATIAL_INDEX_INPUTS = ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.spatialIndex];

function isPatternKey(key) {
  return key.endsWith("*");
}

function matchesPattern(patternKey, artifactName) {
  if (!isPatternKey(patternKey)) {
    return patternKey === artifactName;
  }
  const prefix = patternKey.slice(0, -1);
  return artifactName.startsWith(prefix) && artifactName.endsWith(".json");
}

function graphKeyForArtifact(artifactName) {
  if (Object.hasOwn(ARTIFACT_DEPENDENCY_GRAPH, artifactName)) {
    return artifactName;
  }
  for (const key of Object.keys(ARTIFACT_DEPENDENCY_GRAPH)) {
    if (isPatternKey(key) && matchesPattern(key, artifactName)) {
      return key;
    }
  }
  return null;
}

function clipIdFromArtifact(artifactName, patternKey) {
  const prefix = CLIP_ARTIFACT_PREFIXES[patternKey];
  if (!prefix || !artifactName.startsWith(prefix)) {
    return null;
  }
  return artifactName.slice(prefix.length, -".json".length);
}

export function listClipArtifactPaths(workDir, patternKey) {
  if (!fs.existsSync(workDir)) {
    return [];
  }
  const prefix = CLIP_ARTIFACT_PREFIXES[patternKey];
  if (!prefix) {
    return [];
  }
  return fs.readdirSync(workDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => path.join(workDir, name));
}

export function listObjectArtifactPaths(workDir) {
  if (!fs.existsSync(workDir)) {
    return [];
  }
  return fs.readdirSync(workDir)
    .filter((name) => name.startsWith(OBJECTS_PREFIX) && name.endsWith(".json"))
    .map((name) => path.join(workDir, name));
}

function listPatternInputPaths(workDir, patternKey, forArtifactName) {
  const forKey = graphKeyForArtifact(forArtifactName);
  const forClipId = forKey && isPatternKey(forKey)
    ? clipIdFromArtifact(forArtifactName, forKey)
    : null;
  const depClipId = forClipId && isPatternKey(patternKey)
    ? clipIdFromArtifact(forArtifactName, patternKey) ?? forClipId
    : forClipId;

  if (depClipId && isPatternKey(patternKey)) {
    const prefix = CLIP_ARTIFACT_PREFIXES[patternKey];
    const filePath = path.join(workDir, `${prefix}${depClipId}.json`);
    return fs.existsSync(filePath) ? [filePath] : [];
  }

  return listClipArtifactPaths(workDir, patternKey);
}

export function resolveInputPaths(workDir, artifactName) {
  const key = graphKeyForArtifact(artifactName);
  if (!key) {
    return [];
  }

  const paths = [];
  for (const dep of ARTIFACT_DEPENDENCY_GRAPH[key]) {
    if (isPatternKey(dep)) {
      paths.push(...listPatternInputPaths(workDir, dep, artifactName));
    } else {
      const depPath = path.join(workDir, dep);
      if (fs.existsSync(depPath)) {
        paths.push(depPath);
      }
    }
  }
  return paths;
}

function fileMtimeMs(filePath) {
  return fs.statSync(filePath).mtimeMs;
}

/**
 * Returns true when the artifact is missing or any upstream input is newer (mtime).
 */
export function isArtifactStale(workDir, artifactName) {
  const artifactPath = path.join(workDir, artifactName);
  if (!fs.existsSync(artifactPath)) {
    return true;
  }

  const artifactMtime = fileMtimeMs(artifactPath);
  for (const inputPath of resolveInputPaths(workDir, artifactName)) {
    if (fileMtimeMs(inputPath) > artifactMtime) {
      return true;
    }
  }
  return false;
}

/**
 * Returns all artifacts that transitively depend on `changedArtifact`.
 */
export function getStaleDownstream(changedArtifact) {
  const downstream = new Set();
  const queue = [changedArtifact];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const [artifact, deps] of Object.entries(ARTIFACT_DEPENDENCY_GRAPH)) {
      const dependsOnCurrent = deps.some((dep) => matchesPattern(dep, current) || dep === current);
      if (dependsOnCurrent && !downstream.has(artifact)) {
        downstream.add(artifact);
        queue.push(artifact);
      }
    }
  }

  return [...downstream];
}

export function shouldRebuildArtifact(workDir, artifactName, force = false) {
  if (force) {
    return true;
  }
  return isArtifactStale(workDir, artifactName);
}

export function shouldUseCachedArtifact(workDir, artifactName, force = false) {
  if (force) {
    return false;
  }
  const artifactPath = path.join(workDir, artifactName);
  if (!fs.existsSync(artifactPath)) {
    return false;
  }
  return !isArtifactStale(workDir, artifactName);
}

function readManifestFromWorkDir(workDir) {
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function clipIdFromOutPath(outPath) {
  const base = path.basename(outPath);
  for (const prefix of Object.values(CLIP_ARTIFACT_PREFIXES)) {
    if (base.startsWith(prefix) && base.endsWith(".json")) {
      return base.slice(prefix.length, -".json".length);
    }
  }
  return null;
}

/**
 * Extended clip cache check with explicit manifest, clipId, and live-mode hints.
 */
export function shouldUseCachedClipArtifactWithContext({
  workDir,
  outPath,
  force = false,
  manifest,
  clipId,
  liveModeHints,
}) {
  return shouldUseCachedClipArtifactExtended({
    workDir,
    outPath,
    force,
    manifest,
    clipId,
    liveModeHints,
  });
}

export function shouldUseCachedClipArtifact(workDir, outPath, force = false, options = {}) {
  const manifest = options.manifest ?? readManifestFromWorkDir(workDir);
  const clipId = options.clipId ?? clipIdFromOutPath(outPath);

  if (manifest && clipId) {
    return shouldUseCachedClipArtifactWithContext({
      workDir,
      outPath,
      force,
      manifest,
      clipId,
      liveModeHints: options.liveModeHints,
    });
  }

  return shouldUseCachedArtifact(workDir, path.basename(outPath), force);
}

/** @deprecated Use isArtifactStale(workDir, ARTIFACTS.spatialIndex) */
export function isSpatialIndexStale(workDir) {
  return isArtifactStale(workDir, ARTIFACTS.spatialIndex);
}

/**
 * Records artifact mtimes in manifest without changing manifest mtime (avoids cascade invalidation).
 */
export function recordManifestArtifactMtimes(workDir, artifactNames) {
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  if (!fs.existsSync(manifestPath)) {
    return;
  }

  const prevMtime = fileMtimeMs(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.artifactMtimes = manifest.artifactMtimes ?? {};

  for (const name of artifactNames) {
    const artifactPath = path.join(workDir, name);
    if (fs.existsSync(artifactPath)) {
      manifest.artifactMtimes[name] = fileMtimeMs(artifactPath);
    }
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.utimesSync(manifestPath, prevMtime / 1000, prevMtime / 1000);
}
