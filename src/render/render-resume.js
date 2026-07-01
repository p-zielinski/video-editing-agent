import fs from "node:fs";
import path from "node:path";
import { segmentTempPath } from "./ffmpeg-segment.js";

export const RENDER_PASS_ORDER = [
  "segments",
  "concat",
  "creative",
  "subs",
  "overlays",
  "audio_mix",
  "color_grade",
];

export const PASS_FILES = {
  concat: "concat.mp4",
  creative: "creative.mp4",
  subs: "subs.mp4",
  overlays: "gfx.mp4",
  audio_mix: "mix.mp4",
  color_grade: "graded.mp4",
};

/** Latest checkpoint file required as input before running `pass`. */
const INPUT_CHECKPOINTS = {
  creative: [PASS_FILES.concat],
  subs: [PASS_FILES.creative, PASS_FILES.concat],
  overlays: [PASS_FILES.subs, PASS_FILES.creative, PASS_FILES.concat],
  audio_mix: [PASS_FILES.overlays, PASS_FILES.subs, PASS_FILES.creative, PASS_FILES.concat],
  color_grade: [
    PASS_FILES.audio_mix,
    PASS_FILES.overlays,
    PASS_FILES.subs,
    PASS_FILES.creative,
    PASS_FILES.concat,
  ],
};

export function normalizeFromPass(fromPass) {
  if (!fromPass || fromPass === "segments") {
    return "segments";
  }
  if (!RENDER_PASS_ORDER.includes(fromPass)) {
    throw new Error(
      `--from-pass must be one of: ${RENDER_PASS_ORDER.filter((pass) => pass !== "segments").join("|")}`,
    );
  }
  return fromPass;
}

export function shouldRunPass(fromPass, pass) {
  return RENDER_PASS_ORDER.indexOf(pass) >= RENDER_PASS_ORDER.indexOf(normalizeFromPass(fromPass));
}

function findCheckpoint(tmpDir, candidates) {
  for (const file of candidates) {
    const fullPath = path.join(tmpDir, file);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * @param {string} tmpDir
 * @param {string} [fromPass]
 * @param {number} segmentCount
 */
export function resolveResumeStart(tmpDir, fromPass, segmentCount) {
  const normalized = normalizeFromPass(fromPass);
  if (normalized === "segments") {
    return { runSegments: true, currentPath: null, resumedFromPass: null };
  }

  if (normalized === "concat") {
    for (let i = 0; i < segmentCount; i += 1) {
      const segmentPath = segmentTempPath(tmpDir, i);
      if (!fs.existsSync(segmentPath)) {
        throw new Error(`Brak ${segmentPath} — uruchom pełny render z --keep-tmp`);
      }
    }
    return { runSegments: false, currentPath: null, resumedFromPass: "concat" };
  }

  const checkpoints = INPUT_CHECKPOINTS[normalized];
  const currentPath = findCheckpoint(tmpDir, checkpoints);
  if (!currentPath) {
    throw new Error(
      `Brak pliku wejściowego dla --from-pass ${normalized} w ${tmpDir} `
      + `(szukano: ${checkpoints.join(", ")})`,
    );
  }

  return {
    runSegments: false,
    currentPath,
    resumedFromPass: normalized,
  };
}

export function loadSegmentPaths(tmpDir, segmentCount) {
  return Array.from({ length: segmentCount }, (_, index) => segmentTempPath(tmpDir, index));
}
