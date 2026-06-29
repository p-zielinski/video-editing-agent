import { collectBrollDesyncWarning } from "../render/ffmpeg-segment.js";

function segmentDuration(inSec, outSec) {
  if (!Number.isFinite(inSec) || !Number.isFinite(outSec)) {
    return 0;
  }
  return Math.max(0, outSec - inSec);
}

/**
 * Pre-render B-roll A/V duration mismatch (mirrors render-time broll_av_desync).
 *
 * @param {object} recipe
 */
export function validateBrollAvSync(recipe) {
  const issues = [];

  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      const videoDur = segmentDuration(segment.videoInSec, segment.videoOutSec);
      const audioDur = segmentDuration(segment.audioInSec, segment.audioOutSec);
      const warning = collectBrollDesyncWarning(segment, videoDur, audioDur);
      if (!warning) {
        continue;
      }

      issues.push({
        severity: "warning",
        code: "V25-BROLL-01",
        message: warning.message,
        outputId: output.outputId,
        sceneId: segment.videoRef?.sceneId,
      });
    }
  }

  return issues;
}
