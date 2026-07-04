import { computeReframeCrop } from "./reframe.js";

const DEFAULT_BLUR_SIGMA = 20;

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
 * FFmpeg filter graph for TikTok-style blurred pillarbox (9:16 → 16:9).
 * Expects input on the implicit stream; caller prefixes with [0:v].
 */
export function buildBlurPillarboxFilterGraph(dimensions, { blurSigma = DEFAULT_BLUR_SIGMA } = {}) {
  const width = dimensions.width;
  const height = dimensions.height;
  return [
    "split=2[pb_fg][pb_bg]",
    `[pb_bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=${blurSigma}[pb_blur]`,
    `[pb_fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[pb_fg_scaled]`,
    "[pb_blur][pb_fg_scaled]overlay=(W-w)/2:(H-h)/2",
  ].join(";");
}

/**
 * Compose base video transform with sync/pad extras for segment render.
 *
 * @param {{ type: "vf" | "filter_complex", filter: string } | null} baseResult
 * @param {string[]} extraFilters
 * @returns {{ mode: "vf", chain: string } | { mode: "filter_complex", graph: string } | null}
 */
export function composeSegmentVideoFilter(baseResult, extraFilters = []) {
  const extras = extraFilters.filter(Boolean);
  const extraChain = extras.join(",");

  if (!baseResult && !extraChain) {
    return null;
  }

  if (baseResult?.type === "filter_complex") {
    if (extraChain) {
      return {
        mode: "filter_complex",
        graph: `[0:v]${baseResult.filter}[vbase];[vbase]${extraChain}`,
      };
    }
    return {
      mode: "filter_complex",
      graph: `[0:v]${baseResult.filter}`,
    };
  }

  const chain = [baseResult?.filter, ...extras].filter(Boolean).join(",");
  return chain ? { mode: "vf", chain } : null;
}

/**
 * Build -vf filter chain for a segment (crop, scale, speed).
 *
 * @returns {{ type: "vf" | "filter_complex", filter: string } | null}
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
  const useBlurPillarbox = format !== "9:16" && aspectDiffers && fitMode === "pillarbox_blur";

  const useCropReframe = !useBlurPillarbox && (
    format === "9:16"
    || reframeMode === "face"
    || reframeMode === "subject"
    || useFillInLandscape
  );

  if (useBlurPillarbox && dimensions) {
    const blurGraph = buildBlurPillarboxFilterGraph(dimensions);
    const speed = videoTransform.speed ?? 1;
    if (speed !== 1) {
      return {
        type: "filter_complex",
        filter: `${blurGraph}[pb_out];[pb_out]setpts=PTS/${speed}`,
      };
    }
    return {
      type: "filter_complex",
      filter: blurGraph,
    };
  }

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

  return filters.length > 0
    ? { type: "vf", filter: filters.join(",") }
    : null;
}
