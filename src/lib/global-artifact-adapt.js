import { assignWordIds } from "../schemas/word-index.js";

const SUPPORTED_STEPS = new Set([
  "words",
  "audioAnalysis",
  "keyframes",
  "twelvelabs",
  "vision",
  "objects",
  "faces",
]);

const BATCH_SPECIFIC_TOP_LEVEL = new Set([
  "clipId",
  "sourceContentHash",
]);

/**
 * Remap a batch-scoped scene id to a new clip id.
 *
 * @param {string|null|undefined} sceneId
 * @param {string} newClipId
 * @param {string} cachedClipId
 * @returns {string|null|undefined}
 */
export function remapSceneId(sceneId, newClipId, cachedClipId) {
  if (!sceneId || !newClipId || !cachedClipId) {
    return sceneId;
  }

  const prefix = `${cachedClipId}_`;
  if (sceneId.startsWith(prefix)) {
    return `${newClipId}_${sceneId.slice(prefix.length)}`;
  }

  return sceneId;
}

function stripSceneIdPrefix(sceneId, clipId) {
  if (!sceneId || !clipId) {
    return sceneId;
  }

  const prefix = `${clipId}_`;
  if (sceneId.startsWith(prefix)) {
    return sceneId.slice(prefix.length);
  }

  return sceneId;
}

function restoreSceneId(canonicalSceneId, newClipId, cachedClipId) {
  if (!canonicalSceneId) {
    return canonicalSceneId;
  }

  if (cachedClipId && canonicalSceneId.startsWith(`${cachedClipId}_`)) {
    return remapSceneId(canonicalSceneId, newClipId, cachedClipId);
  }

  if (canonicalSceneId.startsWith(`${newClipId}_`)) {
    return canonicalSceneId;
  }

  return `${newClipId}_${canonicalSceneId}`;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalizeSceneIdField(sceneId, clipId) {
  return stripSceneIdPrefix(sceneId, clipId);
}

function canonicalizeWordsArtifact(artifact, clipId) {
  const canonical = cloneValue(artifact);
  delete canonical.clipId;
  delete canonical.sourceContentHash;

  canonical.words = (artifact.words ?? []).map((entry) => ({
    word: entry.word,
    start: entry.start,
    end: entry.end,
    ...(entry.isFiller !== undefined ? { isFiller: entry.isFiller } : {}),
    ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
  }));

  return canonical;
}

function canonicalizeKeyframesArtifact(artifact, clipId) {
  const canonical = cloneValue(artifact);
  delete canonical.clipId;
  delete canonical.sourceContentHash;

  canonical.keyframes = (artifact.keyframes ?? []).map((frame) => {
    const next = { ...frame };
    if (next.sceneId) {
      next.sceneId = canonicalizeSceneIdField(next.sceneId, clipId);
    }
    delete next.imagePath;
    return next;
  });

  return canonical;
}

function canonicalizeSceneListArtifact(artifact, clipId, listKey) {
  const canonical = cloneValue(artifact);
  delete canonical.clipId;
  delete canonical.sourceContentHash;

  canonical[listKey] = (artifact[listKey] ?? []).map((entry) => {
    if (!entry?.sceneId) {
      return entry;
    }
    return {
      ...entry,
      sceneId: canonicalizeSceneIdField(entry.sceneId, clipId),
    };
  });

  return canonical;
}

function canonicalizeGenericArtifact(artifact) {
  const canonical = cloneValue(artifact);
  for (const key of BATCH_SPECIFIC_TOP_LEVEL) {
    delete canonical[key];
  }
  return canonical;
}

/**
 * Strip batch-specific clip/scene identifiers before global cache storage.
 *
 * @param {string} step
 * @param {object} artifact
 * @returns {object}
 */
export function canonicalizeClipArtifact(step, artifact) {
  if (!SUPPORTED_STEPS.has(step)) {
    throw new Error(`Unsupported global cache step: ${step}`);
  }

  const clipId = artifact?.clipId ?? null;

  switch (step) {
    case "words":
      return canonicalizeWordsArtifact(artifact, clipId);
    case "keyframes":
      return canonicalizeKeyframesArtifact(artifact, clipId);
    case "vision":
      return canonicalizeSceneListArtifact(artifact, clipId, "captions");
    case "objects":
    case "faces":
      return canonicalizeSceneListArtifact(artifact, clipId, "detections");
    case "audioAnalysis":
    case "twelvelabs":
      return canonicalizeGenericArtifact(artifact);
    default:
      return canonicalizeGenericArtifact(artifact);
  }
}

function adaptWordsArtifact(cachedData, newClipId) {
  const adapted = cloneValue(cachedData);
  adapted.clipId = newClipId;
  adapted.words = assignWordIds(cachedData.words ?? [], newClipId);
  return adapted;
}

function adaptKeyframesArtifact(cachedData, newClipId, cachedClipId) {
  const adapted = cloneValue(cachedData);
  adapted.clipId = newClipId;
  adapted.keyframes = (cachedData.keyframes ?? []).map((frame) => {
    const next = {
      ...frame,
      sceneId: restoreSceneId(frame.sceneId, newClipId, cachedClipId),
    };
    delete next.imagePath;
    return next;
  });
  return adapted;
}

function adaptSceneListArtifact(cachedData, newClipId, cachedClipId, listKey) {
  const adapted = cloneValue(cachedData);
  adapted.clipId = newClipId;
  adapted[listKey] = (cachedData[listKey] ?? []).map((entry) => {
    if (!entry?.sceneId) {
      return entry;
    }
    return {
      ...entry,
      sceneId: restoreSceneId(entry.sceneId, newClipId, cachedClipId),
    };
  });
  return adapted;
}

function adaptGenericArtifact(cachedData, newClipId) {
  const adapted = cloneValue(cachedData);
  adapted.clipId = newClipId;
  return adapted;
}

/**
 * Restore a canonical cached artifact for the current batch clip id.
 *
 * @param {string} step
 * @param {object} cachedData
 * @param {string} newClipId
 * @param {string} cachedClipId
 * @returns {object}
 */
export function adaptClipArtifactFromCache(step, cachedData, newClipId, cachedClipId) {
  if (!SUPPORTED_STEPS.has(step)) {
    throw new Error(`Unsupported global cache step: ${step}`);
  }

  switch (step) {
    case "words":
      return adaptWordsArtifact(cachedData, newClipId);
    case "keyframes":
      return adaptKeyframesArtifact(cachedData, newClipId, cachedClipId);
    case "vision":
      return adaptSceneListArtifact(cachedData, newClipId, cachedClipId, "captions");
    case "objects":
    case "faces":
      return adaptSceneListArtifact(cachedData, newClipId, cachedClipId, "detections");
    case "audioAnalysis":
    case "twelvelabs":
      return adaptGenericArtifact(cachedData, newClipId);
    default:
      return adaptGenericArtifact(cachedData, newClipId);
  }
}
