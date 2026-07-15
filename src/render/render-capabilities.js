/**
 * Render support levels for editing techniques and timeline sync/speed combos.
 * Derived from technique-to-ffmpeg.js and ffmpeg-segment.js behavior.
 */

export const RENDER_SUPPORT_LEVELS = [
  "full",
  "partial",
  "stub",
  "audio_only",
  "graphics_only",
  "segment_only",
];

/**
 * Timeline segment fields rendered in ffmpeg-segment.js (not creativeMoments).
 * Keys match recipe paths or shorthand ids used in docs.
 */
export const SEGMENT_RENDER_FEATURES = {
  "videoTransform.playbackMode:reverse": "segment_only",
  "videoTransform.playbackMode:boomerang": "segment_only",
};

/** techniqueId → renderSupport */
const TECHNIQUE_RENDER_SUPPORT = {
  // camera — full FFmpeg filters
  zoom_punch_in: "full",
  zoom_punch_out: "full",
  snap_zoom: "full",
  zoom_slow_push: "full",
  ken_burns_light: "full",
  reframe_follow_subject: "full",
  // edit
  jump_cut: "partial",
  hard_cut_energy: "partial",
  cut_mid_sentence: "full",
  cut_on_beat: "full",
  match_cut: "stub",
  // transition
  crossfade: "full",
  dip_to_black: "full",
  whip_pan: "stub",
  wipe_left: "full",
  wipe_right: "full",
  slide_left: "full",
  slide_right: "full",
  slide_up: "full",
  slide_down: "full",
  j_cut: "segment_only",
  l_cut: "segment_only",
  // audio — mix plan only
  music_swell: "audio_only",
  music_drop: "audio_only",
  silence_beat: "audio_only",
  voice_pitch_shift: "audio_only",
  // graphics — overlay pass
  hook_title_overlay: "graphics_only",
  emphasis_text: "graphics_only",
  chapter_card: "graphics_only",
  pattern_interrupt: "graphics_only",
  hook_visual_punch: "full",
  retention_beat: "full",
  cinematic_frame: "full",
  color_desaturate: "full",
  color_saturation_boost: "full",
};

/**
 * syncMode + speed combinations the segment renderer cannot apply faithfully.
 * Keys: syncMode; values: predicate(syncMode, speed, speedMode) → unsupported when true.
 */
const UNSUPPORTED_SYNC_SPEED = [
  {
    syncMode: "fit_video_to_audio",
    when: (speed) => speed !== 1,
  },
  {
    syncMode: "fit_audio_to_video",
    when: (speed, speedMode) => speed !== 1 && speedMode === "video_audio",
  },
];

export function getTechniqueRenderSupport(techniqueId) {
  return TECHNIQUE_RENDER_SUPPORT[techniqueId] ?? null;
}

export function isSyncSpeedSupported(syncMode, speed, speedMode = "video_audio") {
  const normalizedSpeed = speed ?? 1;
  if (normalizedSpeed === 1) {
    return true;
  }
  const mode = syncMode ?? "align_start";
  for (const rule of UNSUPPORTED_SYNC_SPEED) {
    if (rule.syncMode === mode && rule.when(normalizedSpeed, speedMode ?? "video_audio")) {
      return false;
    }
  }
  return true;
}

export function getSegmentRenderFeatureSupport(featureKey) {
  return SEGMENT_RENDER_FEATURES[featureKey] ?? null;
}

export { TECHNIQUE_RENDER_SUPPORT };
