import {
  readGlobalAnalysisCache,
  writeGlobalAnalysisCache,
} from "./global-analysis-cache.js";
import {
  canonicalizeClipArtifact,
  adaptClipArtifactFromCache,
} from "./global-artifact-adapt.js";

/**
 * Read a global cache entry and adapt it for the current batch clip.
 *
 * @param {{
 *   step: string,
 *   contentHash: string,
 *   configFingerprint: string,
 *   clipId: string,
 *   cachedClipIdFromData?: string|null,
 *   cacheRoot?: string,
 *   disabled?: boolean,
 * }} params
 * @returns {object|null}
 */
export function tryRestoreGlobalClipArtifact({
  step,
  contentHash,
  configFingerprint,
  clipId,
  cachedClipIdFromData,
  cacheRoot,
  disabled,
}) {
  if (!contentHash) {
    return null;
  }

  const envelope = readGlobalAnalysisCache({
    step,
    contentHash,
    configFingerprint,
    cacheRoot,
    disabled,
  });

  if (!envelope?.data) {
    return null;
  }

  const cachedClipId = cachedClipIdFromData ?? envelope.meta?.cachedClipId ?? clipId;
  return adaptClipArtifactFromCache(step, envelope.data, clipId, cachedClipId);
}

/**
 * Canonicalize and store a per-clip artifact in the global analysis cache.
 *
 * @param {{
 *   step: string,
 *   contentHash: string,
 *   configFingerprint: string,
 *   artifact: object,
 *   cacheRoot?: string,
 *   disabled?: boolean,
 * }} params
 * @returns {object|null}
 */
export function publishGlobalClipArtifact({
  step,
  contentHash,
  configFingerprint,
  artifact,
  cacheRoot,
  disabled,
}) {
  if (!contentHash || !artifact) {
    return null;
  }

  const canonical = canonicalizeClipArtifact(step, artifact);
  return writeGlobalAnalysisCache({
    step,
    contentHash,
    configFingerprint,
    data: canonical,
    meta: artifact.clipId ? { cachedClipId: artifact.clipId } : undefined,
    cacheRoot,
    disabled,
  });
}

/**
 * Attempt global cache restore when enabled for this step run.
 *
 * @param {{
 *   enabled?: boolean,
 *   step: string,
 *   contentHash: string|null|undefined,
 *   configFingerprint: string,
 *   clipId: string,
 *   cacheRoot?: string,
 *   disabled?: boolean,
 * }} params
 * @returns {object|null}
 */
export function maybeUseGlobalClipCache({
  enabled = true,
  step,
  contentHash,
  configFingerprint,
  clipId,
  cacheRoot,
  disabled,
}) {
  if (enabled === false || !contentHash) {
    return null;
  }

  return tryRestoreGlobalClipArtifact({
    step,
    contentHash,
    configFingerprint,
    clipId,
    cacheRoot,
    disabled,
  });
}
