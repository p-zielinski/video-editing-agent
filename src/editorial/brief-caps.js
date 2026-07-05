import { DEFAULT_AUDIO_CAPS, DIRECTOR_AUDIO_CAPS } from "./audio-index-summary.js";

/** Caps for director initial brief and shared editorial context limits. */
export const DIRECTOR_BRIEF_CAPS = {
  maxWordsPerScene: 120,
  spatialAnchorLimit: 3,
  includeFullTopicIndex: true,
  audioCaps: DIRECTOR_AUDIO_CAPS,
  L1_SUMMARY_MAX_CHARS: 500,
  VISION_CAPTION_MAX_CHARS: 200,
  L1_SCENE_SUMMARIES_THRESHOLD: 30,
  OMITTED_SUMMARY_MAX_CHARS: 120,
  BROLL_SYNC_HINTS_LIMIT: 25,
  MIN_SCENES_PER_CLIP_COMPACT: 2,
  TOPIC_INDEX_FULL_THRESHOLD: 15,
  MATCHING_SCENES_CAP: 12,
  SCENE_MAP_LARGE_BATCH_SCENE_COUNT: 80,
};

/** Drill-down uses the same caps as the initial director brief (not critic defaults). */
export const DRILL_DOWN_CAPS = { ...DIRECTOR_BRIEF_CAPS };

/** Segment director brief shares director caps. */
export const SEGMENT_BRIEF_CAPS = { ...DIRECTOR_BRIEF_CAPS };

/** Tighter caps for critic / fixer review passes. */
export const CRITIC_BRIEF_CAPS = {
  maxWordsPerScene: 80,
  spatialAnchorLimit: 1,
  includeFullTopicIndex: false,
  audioCaps: DEFAULT_AUDIO_CAPS,
};
