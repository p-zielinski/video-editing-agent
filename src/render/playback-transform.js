/** Default forward half-length for boomerang when boomerangHalfSec is unset. */
export const DEFAULT_BOOMERANG_HALF_SEC = 2.0;

/** Hard cap on boomerang forward half (renderer clamps either way). */
export const MAX_BOOMERANG_HALF_SEC = 4;

export function resolvePlaybackMode(segment) {
  return segment.videoTransform?.playbackMode ?? "normal";
}

/**
 * Forward half-duration for boomerang: min(half source span, configured/default cap).
 */
export function resolveBoomerangHalfSec(segment, videoDurSec) {
  const span = Math.max(0.02, videoDurSec);
  const configured = segment.videoTransform?.boomerangHalfSec ?? DEFAULT_BOOMERANG_HALF_SEC;
  const capped = Math.min(configured, MAX_BOOMERANG_HALF_SEC);
  return Math.min(span / 2, capped);
}

export function shouldMutePlaybackAudio(segment) {
  const mode = resolvePlaybackMode(segment);
  return mode === "reverse" || mode === "boomerang";
}

/**
 * Adjust segment output duration for reverse/boomerang playback modes.
 *
 * @param {object} segment
 * @param {number} spedVideoDurSec — source video span after speed transform
 * @param {number} baseDurationSec — timeline duration before playback adjustment
 */
export function resolvePlaybackOutputDuration(segment, spedVideoDurSec, baseDurationSec) {
  const mode = resolvePlaybackMode(segment);
  if (mode === "boomerang") {
    const half = resolveBoomerangHalfSec(segment, spedVideoDurSec);
    return Math.max(0.04, 2 * half);
  }
  if (mode === "reverse") {
    return baseDurationSec;
  }
  return baseDurationSec;
}

/**
 * FFmpeg filter fragment for reverse/boomerang on an already-transformed video pad.
 * Returns null for normal playback. Caller supplies input label (e.g. [vbase]).
 */
export function buildPlaybackVideoFilter(mode, halfSec, inputLabel = "[vbase]") {
  if (mode === "reverse") {
    return `${inputLabel}reverse`;
  }
  if (mode === "boomerang") {
    const d = Math.max(0.04, halfSec).toFixed(4);
    return [
      `${inputLabel}split=2[bfwdin][brevin]`,
      `[bfwdin]trim=0:${d},setpts=PTS-STARTPTS[bfwd]`,
      `[brevin]trim=0:${d},reverse,setpts=PTS-STARTPTS[brev]`,
      "[bfwd][brev]concat=n=2:v=1:a=0",
    ].join(";");
  }
  return null;
}

/**
 * Apply playback transform to composed segment video filter result.
 */
export function applyPlaybackToVideoFilter(videoFilter, segment, spedVideoDurSec) {
  const mode = resolvePlaybackMode(segment);
  if (mode === "normal") {
    return videoFilter;
  }

  if (mode === "reverse") {
    if (!videoFilter) {
      return { mode: "vf", chain: "reverse" };
    }
    if (videoFilter.mode === "filter_complex") {
      return {
        mode: "filter_complex",
        graph: `${videoFilter.graph}[vbase];${buildPlaybackVideoFilter("reverse", 0, "[vbase]")}`,
      };
    }
    return { mode: "vf", chain: `${videoFilter.chain},reverse` };
  }

  const half = resolveBoomerangHalfSec(segment, spedVideoDurSec);
  if (!videoFilter) {
    return {
      mode: "filter_complex",
      graph: buildPlaybackVideoFilter("boomerang", half, "[0:v]"),
    };
  }
  if (videoFilter.mode === "filter_complex") {
    return {
      mode: "filter_complex",
      graph: `${videoFilter.graph}[vbase];${buildPlaybackVideoFilter("boomerang", half, "[vbase]")}`,
    };
  }
  return {
    mode: "filter_complex",
    graph: `[0:v]${videoFilter.chain}[vbase];${buildPlaybackVideoFilter("boomerang", half, "[vbase]")}`,
  };
}
