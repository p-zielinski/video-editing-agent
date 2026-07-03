import { computeReframeCrop } from "./reframe.js";

function findSpatialAnchor(spatialIndex, sceneId) {
  const scene = spatialIndex?.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene?.anchors?.length) {
    return scene?.primaryAnchor ?? null;
  }
  return scene.primaryAnchor ?? scene.anchors[0];
}

function targetAspectForFormat(format) {
  return format === "9:16" ? 9 / 16 : 16 / 9;
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
  const sourceW = sourceRes.w ?? 1920;
  const sourceH = sourceRes.h ?? 1080;
  const sourceAspect = sourceW / sourceH;

  const videoTransform = segment.videoTransform ?? {};
  const reframeMode = videoTransform.reframe;
  const fitMode = videoTransform.fitMode;
  const targetAspect = targetAspectForFormat(format);
  const aspectDiffers = Math.abs(sourceAspect - targetAspect) > 0.01;

  const useFillInLandscape = format !== "9:16" && aspectDiffers && fitMode === "fill";

  const useCropReframe = format === "9:16"
    || reframeMode === "face"
    || reframeMode === "subject"
    || useFillInLandscape;

  if (useCropReframe && dimensions) {
    const useSpatialAnchor = reframeMode === "face" || reframeMode === "subject";
    let spatialAnchor = null;
    if (useSpatialAnchor && sceneId && spatialIndex) {
      const anchor = findSpatialAnchor(spatialIndex, sceneId);
      if (anchor) {
        spatialAnchor = {
          bbox: anchor.bbox,
          anchorType: anchor.type ?? anchor.anchorType,
        };
      }
    }

    const crop = videoTransform.crop
      ?? computeReframeCrop({
        format,
        spatialAnchor: useSpatialAnchor ? spatialAnchor : null,
        sourceResolution: { w: sourceW, h: sourceH },
      });

    const cropX = Math.round(crop.x * sourceW);
    const cropY = Math.round(crop.y * sourceH);
    const cropW = Math.round(crop.w * sourceW);
    const cropH = Math.round(crop.h * sourceH);

    filters.push(`crop=${cropW}:${cropH}:${cropX}:${cropY}`);
    filters.push(`scale=${dimensions.width}:${dimensions.height}`);
  } else if (dimensions) {
    filters.push(`scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2`);
  }

  const speed = videoTransform.speed ?? 1;
  if (speed !== 1) {
    filters.push(`setpts=PTS/${speed}`);
  }

  return filters.length > 0 ? filters.join(",") : null;
}
