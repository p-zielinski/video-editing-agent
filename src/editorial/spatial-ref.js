/**
 * Derive clipId from sceneId (e.g. clip01_scene001 → clip01).
 */
export function deriveClipIdFromSceneId(sceneId) {
  const match = String(sceneId).match(/^(.+)_scene\d+$/);
  if (match) {
    return match[1];
  }
  const underscore = String(sceneId).indexOf("_");
  return underscore > 0 ? String(sceneId).slice(0, underscore) : sceneId;
}

/**
 * Build a valid spatialRef object from a spatial index anchor.
 */
export function buildSpatialRefFromAnchor(sceneId, clipId, anchor) {
  return {
    clipId: clipId ?? deriveClipIdFromSceneId(sceneId),
    sceneId,
    anchorType: anchor.type,
    bbox: [...anchor.bbox],
    ...(anchor.timestampSec != null ? { timestampSec: anchor.timestampSec } : {}),
  };
}

/**
 * Pick the best anchor for a scene, optionally preferring a type (face > subject > object).
 */
export function findBestAnchor(spatialIndex, sceneId, preferredType) {
  const entry = (spatialIndex?.scenes ?? []).find((s) => s.sceneId === sceneId);
  if (!entry?.anchors?.length) {
    return null;
  }

  if (preferredType) {
    const preferred = entry.anchors.find((a) => a.type === preferredType);
    if (preferred) {
      return preferred;
    }
  }

  return entry.anchors[0];
}

/**
 * Build 1–2 spatialRef examples from spatial index for director briefs.
 */
export function buildSpatialRefExamples(spatialIndex, limit = 2) {
  return (spatialIndex?.scenes ?? [])
    .filter((entry) => entry.anchors?.length > 0)
    .slice(0, limit)
    .map((entry) => buildSpatialRefFromAnchor(
      entry.sceneId,
      entry.clipId ?? deriveClipIdFromSceneId(entry.sceneId),
      entry.anchors[0],
    ));
}
