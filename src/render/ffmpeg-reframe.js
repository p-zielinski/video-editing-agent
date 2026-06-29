import { computeReframeCrop } from "./reframe.js";

function findSpatialAnchor(spatialIndex, sceneId) {
  const scene = spatialIndex?.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene?.anchors?.length) {
    return scene?.primaryAnchor ?? null;
  }
  return scene.primaryAnchor ?? scene.anchors[0];
}

/**
 * Build -vf filter chain for a segment (crop, scale, speed).
 */
export function buildSegmentVideoFilter({
  segment,
  format,
  dimensions,
  recipe,
  spatialIndex,
  context,
}) {
  const filters = [];
  const clipId = segment.videoRef?.clipId;
  const sceneId = segment.videoRef?.sceneId;
  const clipMeta = clipId ? context?.clips?.[clipId] : null;
  const sourceRes = clipMeta?.resolution ?? { w: 1920, h: 1080 };

  const reframeMode = segment.videoTransform?.reframe;
  const needsReframe = format === "9:16" || reframeMode === "face" || reframeMode === "subject";

  if (needsReframe && dimensions) {
    let spatialAnchor = null;
    if (sceneId && spatialIndex) {
      const anchor = findSpatialAnchor(spatialIndex, sceneId);
      if (anchor) {
        spatialAnchor = {
          bbox: anchor.bbox,
          anchorType: anchor.type ?? anchor.anchorType,
        };
      }
    }

    const crop = segment.videoTransform?.crop
      ?? computeReframeCrop({
        format,
        spatialAnchor,
        sourceResolution: { w: sourceRes.w ?? 1920, h: sourceRes.h ?? 1080 },
      });

    const w = sourceRes.w ?? 1920;
    const h = sourceRes.h ?? 1080;
    const cropX = Math.round(crop.x * w);
    const cropY = Math.round(crop.y * h);
    const cropW = Math.round(crop.w * w);
    const cropH = Math.round(crop.h * h);

    filters.push(`crop=${cropW}:${cropH}:${cropX}:${cropY}`);
    filters.push(`scale=${dimensions.width}:${dimensions.height}`);
  } else if (dimensions) {
    filters.push(`scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2`);
  }

  const speed = segment.videoTransform?.speed ?? 1;
  if (speed !== 1) {
    filters.push(`setpts=PTS/${speed}`);
  }

  return filters.length > 0 ? filters.join(",") : null;
}
