import { computeReframeCrop, subjectFitsInCropWindow, unionAnchorBbox } from "./reframe.js";

const DEFAULT_BLUR_SIGMA = 20;
const SUBJECT_ANCHOR_TYPES = new Set(["face", "subject", "object"]);

function findSpatialAnchors(spatialIndex, sceneId, reframeMode) {
  const scene = spatialIndex?.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene?.anchors?.length) {
    return scene?.primaryAnchor ? [scene.primaryAnchor] : [];
  }

  if (reframeMode === "subject") {
    const subjectRelevant = scene.anchors.filter((anchor) => {
      const type = anchor.type ?? anchor.anchorType;
      if (!SUBJECT_ANCHOR_TYPES.has(type)) {
        return false;
      }
      const label = String(anchor.label ?? "").toLowerCase();
      return type === "subject"
        || type === "face"
        || label.includes("dog")
        || label.includes("person")
        || label.includes("man")
        || label.includes("woman");
    });
    if (subjectRelevant.length > 0) {
      return subjectRelevant;
    }
  }

  if (reframeMode === "face") {
    const face = scene.anchors.find((anchor) => (anchor.type ?? anchor.anchorType) === "face");
    if (face) {
      return [face];
    }
  }

  if (scene.primaryAnchor) {
    return [scene.primaryAnchor];
  }

  return [scene.anchors[0]];
}

function targetAspectForFormat(format) {
  return format === "9:16" ? 9 / 16 : 16 / 9;
}

function isNoOpCrop(crop) {
  return crop.w >= 0.99 && crop.h >= 0.99 && crop.x <= 0.01 && crop.y <= 0.01;
}

function formatCropFilter(crop) {
  const x = crop.x.toFixed(6);
  const y = crop.y.toFixed(6);
  const w = crop.w.toFixed(6);
  const h = crop.h.toFixed(6);
  return `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y}`;
}

function scalePadFit(dimensions) {
  return [
    `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease`,
    `pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2`,
  ];
}

function scaleFillExact(dimensions) {
  return [
    `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase`,
    `crop=${dimensions.width}:${dimensions.height}`,
  ];
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

  const wantsPillarbox = fitMode === "pillarbox" || fitMode === "pillarbox_blur";
  const useFillInLandscape = format !== "9:16" && aspectDiffers && fitMode === "fill";
  const useBlurPillarbox = format !== "9:16" && aspectDiffers && fitMode === "pillarbox_blur";

  const useSpatialAnchor = reframeMode === "face" || reframeMode === "subject";
  let spatialAnchors = [];
  if (useSpatialAnchor && sceneId && spatialIndex) {
    spatialAnchors = findSpatialAnchors(spatialIndex, sceneId, reframeMode);
  }
  const unionBbox = unionAnchorBbox(spatialAnchors);
  const spatialAnchor = unionBbox
    ? { bbox: [unionBbox.x, unionBbox.y, unionBbox.w, unionBbox.h] }
    : (spatialAnchors[0] ? {
      bbox: spatialAnchors[0].bbox,
      anchorType: spatialAnchors[0].type ?? spatialAnchors[0].anchorType,
    } : null);

  const subjectTooWideForCrop = useSpatialAnchor
    && unionBbox
    && !subjectFitsInCropWindow({
      unionBbox,
      sourceAspect,
      targetAspect,
    });

  const useCropReframe = !useBlurPillarbox
    && !wantsPillarbox
    && !subjectTooWideForCrop
    && (
      (format === "9:16" && (fitMode === "fill" || reframeMode === "face" || reframeMode === "subject"))
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
    const crop = videoTransform.crop
      ?? computeReframeCrop({
        format,
        spatialAnchor: useSpatialAnchor ? spatialAnchor : null,
        sourceResolution: { w: sourceW, h: sourceH },
      });

    if (!isNoOpCrop(crop)) {
      filters.push(formatCropFilter(crop));
    }
    filters.push(...scaleFillExact(dimensions));
  } else if (dimensions) {
    filters.push(...scalePadFit(dimensions));
  }

  const speed = videoTransform.speed ?? 1;
  if (speed !== 1) {
    filters.push(`setpts=PTS/${speed}`);
  }

  return filters.length > 0
    ? { type: "vf", filter: filters.join(",") }
    : null;
}
