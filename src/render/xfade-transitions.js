/** Techniques applied at segment join boundaries via FFmpeg xfade/acrossfade. */
export const BOUNDARY_TRANSITION_TECHNIQUE_IDS = [
  "crossfade",
  "wipe_left",
  "wipe_right",
  "wipe_up",
  "wipe_down",
  "slide_left",
  "slide_right",
  "slide_up",
  "slide_down",
];

export const BOUNDARY_TRANSITION_TECHNIQUE_SET = new Set(BOUNDARY_TRANSITION_TECHNIQUE_IDS);

const FFMPEG_TRANSITION_BY_TECHNIQUE = {
  crossfade: "fade",
  wipe_left: "wipeleft",
  wipe_right: "wiperight",
  wipe_up: "wipeup",
  wipe_down: "wipedown",
  slide_left: "slideleft",
  slide_right: "slideright",
  slide_up: "slideup",
  slide_down: "slidedown",
};

export function isBoundaryTransitionTechnique(techniqueId) {
  return BOUNDARY_TRANSITION_TECHNIQUE_SET.has(techniqueId);
}

export function resolveXfadeTransitionType(techniqueId) {
  return FFMPEG_TRANSITION_BY_TECHNIQUE[techniqueId] ?? null;
}

export function buildXfadeVideoFilter(leftLabel, rightLabel, outputLabel, {
  durationSec,
  offsetSec,
  transitionType = "fade",
}) {
  const d = Math.max(0.05, durationSec);
  const offset = Math.max(0, offsetSec);
  return `[${leftLabel}][${rightLabel}]xfade=transition=${transitionType}:duration=${d}:offset=${offset}[${outputLabel}]`;
}

export function buildAcrossfadeAudioFilter(leftLabel, rightLabel, outputLabel, durationSec) {
  const d = Math.max(0.05, durationSec);
  return `[${leftLabel}][${rightLabel}]acrossfade=d=${d}:c1=tri:c2=tri[${outputLabel}]`;
}
