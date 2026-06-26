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
