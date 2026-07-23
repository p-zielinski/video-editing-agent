const FORMAT_ASPECT = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function anchorCenter(spatialAnchor) {
  const bbox = spatialAnchor?.bbox;
  if (!bbox || bbox.length < 4) {
    return { cx: 0.5, cy: 0.5 };
  }
  const [x, y, w, h] = bbox;
  return { cx: x + w / 2, cy: y + h / 2 };
}

export function unionAnchorBbox(anchors = []) {
  const valid = anchors.filter((anchor) => Array.isArray(anchor?.bbox) && anchor.bbox.length === 4);
  if (valid.length === 0) {
    return null;
  }

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;

  for (const anchor of valid) {
    const [x, y, w, h] = anchor.bbox;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  return {
    x: clamp(minX, 0, 1),
    y: clamp(minY, 0, 1),
    w: clamp(maxX - minX, 0, 1),
    h: clamp(maxY - minY, 0, 1),
  };
}

/**
 * Whether a subject union bbox fits inside the target-aspect crop window with margin.
 */
export function subjectFitsInCropWindow({
  unionBbox,
  sourceAspect,
  targetAspect,
  margin = 0.04,
}) {
  if (!unionBbox) {
    return true;
  }

  let cropW;
  let cropH;
  if (sourceAspect > targetAspect) {
    cropH = 1;
    cropW = targetAspect / sourceAspect;
  } else {
    cropW = 1;
    cropH = sourceAspect / targetAspect;
  }

  return unionBbox.w <= cropW + margin && unionBbox.h <= cropH + margin;
}

/**
 * Compute a normalized crop box (0–1) to reframe source video into target format.
 * Centers on face/subject bbox when spatialAnchor is provided (9:16 shorts).
 *
 * @param {{ format: string, spatialAnchor?: object, sourceResolution?: { w: number, h: number } }} params
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function computeReframeCrop({ format, spatialAnchor, sourceResolution }) {
  const sourceW = sourceResolution?.w ?? 1920;
  const sourceH = sourceResolution?.h ?? 1080;
  const sourceAspect = sourceW / sourceH;
  const targetAspect = FORMAT_ASPECT[format] ?? sourceAspect;

  if (Math.abs(sourceAspect - targetAspect) < 0.01) {
    return { x: 0, y: 0, w: 1, h: 1 };
  }

  let cropW;
  let cropH;
  if (sourceAspect > targetAspect) {
    cropH = 1;
    cropW = targetAspect / sourceAspect;
  } else {
    cropW = 1;
    cropH = sourceAspect / targetAspect;
  }

  const { cx, cy } = anchorCenter(spatialAnchor);
  const x = clamp(cx - cropW / 2, 0, 1 - cropW);
  const y = clamp(cy - cropH / 2, 0, 1 - cropH);

  return { x, y, w: cropW, h: cropH };
}
