import fs from "node:fs";
import path from "node:path";
import { shouldUseCachedArtifact } from "../pipeline/artifact-deps.js";
import { readJson } from "../pipeline/work-paths.js";
import { computeSourceContentHash } from "./source-hash.js";

/** Expected artifact schema versions per clip artifact type. */
export const EXPECTED_ARTIFACT_VERSIONS = {
  words: "1.0",
  audioAnalysis: "1.0",
  keyframes: "1.0",
  twelvelabs: "1.1",
  vision: "1.0",
  objects: "1.0",
  faces: "1.0",
};

const ARTIFACT_PREFIX_TO_NAME = {
  "01-words-": "words",
  "01b-audio-analysis-": "audioAnalysis",
  "02-keyframes-": "keyframes",
  "03b-twelvelabs-": "twelvelabs",
  "03-vision-": "vision",
  "04-objects-": "objects",
  "04a-faces-": "faces",
};

function findManifestClip(manifest, clipId) {
  const clips = manifest?.clips ?? [];
  const byId = clips.find((clip) => clip.clipId === clipId);
  if (byId) {
    return byId;
  }

  const match = /^clip(\d+)$/i.exec(clipId ?? "");
  if (!match) {
    return null;
  }

  const index = Number(match[1]) - 1;
  return clips[index] ?? null;
}

function compareVersions(left, right) {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let i = 0; i < length; i += 1) {
    const diff = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function resolveArtifactNameFromOutPath(outPath) {
  const base = path.basename(outPath);
  for (const [prefix, name] of Object.entries(ARTIFACT_PREFIX_TO_NAME)) {
    if (base.startsWith(prefix)) {
      return name;
    }
  }
  return null;
}

function isStubArtifactStaleInLiveMode(artifact, liveModeHints) {
  if (!liveModeHints) {
    return false;
  }
  const inLiveMode = liveModeHints.useStub === false || liveModeHints.twelvelabsLive === true;
  if (!inLiveMode) {
    return false;
  }
  return artifact?.indexingStatus === "stub";
}

/**
 * @param {object|null|undefined} manifest
 * @param {string} clipId
 * @returns {string|null}
 */
export function getManifestClipHash(manifest, clipId) {
  const clip = findManifestClip(manifest, clipId);
  return clip?.contentHash ?? null;
}

/**
 * Prefer manifest clip contentHash; fall back to hashing the source file.
 *
 * @param {object|null|undefined} manifest
 * @param {string} clipId
 * @param {string|null|undefined} sourcePath
 * @returns {Promise<string|null>}
 */
export async function resolveClipContentHash(manifest, clipId, sourcePath) {
  const manifestHash = getManifestClipHash(manifest, clipId);
  if (manifestHash) {
    return manifestHash;
  }
  return computeSourceContentHash(sourcePath);
}

/**
 * @param {{ manifest: object, clipId: string, artifact: object }} params
 * @returns {boolean}
 */
export function isClipArtifactContentStale({ manifest, clipId, artifact }) {
  const manifestHash = getManifestClipHash(manifest, clipId);
  if (!manifestHash) {
    return false;
  }

  if (!artifact?.sourceContentHash) {
    return true;
  }

  return artifact.sourceContentHash !== manifestHash;
}

/**
 * @param {{ artifactName: string, artifact: object }} params
 * @returns {boolean}
 */
export function isClipArtifactVersionStale({ artifactName, artifact }) {
  const expectedVersion = EXPECTED_ARTIFACT_VERSIONS[artifactName];
  if (!expectedVersion) {
    return false;
  }

  if (artifactName === "twelvelabs" && artifact?.indexingStatus === "stub") {
    return false;
  }

  const artifactVersion = artifact?.version ?? "0.0";
  return compareVersions(artifactVersion, expectedVersion) < 0;
}

/**
 * Extended cache check: mtime graph + source hash + schema version + live stub invalidation.
 *
 * @param {{
 *   workDir: string,
 *   outPath: string,
 *   force?: boolean,
 *   manifest: object,
 *   clipId: string,
 *   liveModeHints?: { useStub?: boolean, twelvelabsLive?: boolean },
 * }} params
 * @returns {boolean}
 */
export function shouldUseCachedClipArtifactExtended({
  workDir,
  outPath,
  force = false,
  manifest,
  clipId,
  liveModeHints,
}) {
  if (!shouldUseCachedArtifact(workDir, path.basename(outPath), force)) {
    return false;
  }

  if (!fs.existsSync(outPath)) {
    return false;
  }

  const artifact = readJson(outPath);
  if (isClipArtifactContentStale({ manifest, clipId, artifact })) {
    return false;
  }

  const artifactName = resolveArtifactNameFromOutPath(outPath);
  if (artifactName && isClipArtifactVersionStale({ artifactName, artifact })) {
    return false;
  }

  if (isStubArtifactStaleInLiveMode(artifact, liveModeHints)) {
    return false;
  }

  return true;
}
