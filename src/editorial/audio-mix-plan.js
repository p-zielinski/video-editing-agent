import {
  VOICE_TARGET_LUFS,
  PRE_WHISPER_NORMALIZE_LUFS,
  MUSIC_DEFAULT_VOLUME_DB,
  MUSIC_DEFAULT_DUCKING_DB,
  pickByMood,
  calculateMusicGain,
  resolveTrackById,
} from "./music-library.js";

function inferDominantMood(batchSummary, batchContext = {}) {
  if (batchContext.theme) {
    const theme = String(batchContext.theme).toLowerCase();
    if (theme.includes("short") || theme.includes("energy")) {
      return "energetic";
    }
    if (theme.includes("calm") || theme.includes("reflect")) {
      return "calm";
    }
  }

  if (batchSummary?.dominantMood) {
    return batchSummary.dominantMood;
  }

  const bpm = batchSummary?.estimatedBpm;
  if (Number.isFinite(bpm) && bpm >= 115) {
    return "upbeat";
  }

  return "vlog";
}

function shouldRecommendMusicBed({ batchSummary, batchContext = {}, outputs = [] }) {
  if (batchContext.musicBed === false || /no\s*music/i.test(String(batchContext.notes ?? ""))) {
    return false;
  }

  const hasShort = outputs.some((o) => o.outputKind === "short");
  const totalSilence = batchSummary?.totalSilenceSec ?? 0;
  const clipCount = batchSummary?.clipCount ?? 0;

  if (hasShort || clipCount > 1 || totalSilence > 5) {
    return true;
  }

  return /music|bed|soundtrack/i.test(String(batchContext.notes ?? ""));
}

/**
 * Derive default audioMixPlan v2.3 from audio index analysis.
 */
export function deriveAudioMixPlanDefaults({
  audioIndex,
  outputs = [],
  batchContext = {},
  perClipAnalysis = [],
  catalogPath,
} = {}) {
  const batchSummary = audioIndex?.batchSummary ?? {};
  const avgVoiceLufs = batchSummary.avgVoiceLufs ?? null;
  const estimatedBpm = batchSummary.estimatedBpm;

  const plan = {
    voiceTargetLufs: VOICE_TARGET_LUFS,
    preWhisperNormalizeLufs: PRE_WHISPER_NORMALIZE_LUFS,
    musicBed: null,
    segments: [],
  };

  if (!shouldRecommendMusicBed({ batchSummary, batchContext, outputs })) {
    return plan;
  }

  const mood = inferDominantMood(batchSummary, batchContext);
  const recommendedTrackId = audioIndex?.clips?.find((c) => c.recommendedTrackId)?.recommendedTrackId;
  const resolved = recommendedTrackId
    ? resolveTrackById(recommendedTrackId, { catalogPath })
    : { track: pickByMood(mood, { bpm: estimatedBpm, catalogPath }), reason: null };
  const track = resolved.track;

  if (!track) {
    return plan;
  }

  plan.musicBed = {
    trackId: track.trackId,
    volumeDb: calculateMusicGain({
      voiceLufs: avgVoiceLufs,
      trackLufs: track.integratedLufs,
    }),
    duckingDb: MUSIC_DEFAULT_DUCKING_DB,
  };

  const outputIds = outputs.length > 0
    ? outputs.map((o) => o.outputId)
    : (batchContext.requiredFormats ?? ["16:9", "9:16"]).map((format, idx) => `output_${idx}_${format.replace(":", "x")}`);

  for (const outputId of outputIds) {
    const output = outputs.find((o) => o.outputId === outputId);
    let musicOutSec = 120;
    if (output?.timeline?.length) {
      musicOutSec = output.timeline.reduce((max, seg) => {
        const end = seg.outputEndSec
          ?? (seg.outputStartSec ?? 0) + (seg.videoOutSec - seg.videoInSec);
        return Math.max(max, end);
      }, 0);
    }

    plan.segments.push({
      outputId,
      musicInSec: 0,
      musicOutSec: Math.max(1, musicOutSec),
      duckUnderVoice: true,
    });
  }

  if (perClipAnalysis.length > 0 && plan.musicBed && !Number.isFinite(plan.musicBed.volumeDb)) {
    const voiceLufs = perClipAnalysis.find((c) => Number.isFinite(c.voiceLufs))?.voiceLufs;
    plan.musicBed.volumeDb = calculateMusicGain({
      voiceLufs,
      trackLufs: track.integratedLufs,
      baseVolumeDb: MUSIC_DEFAULT_VOLUME_DB,
    });
  }

  return plan;
}

export function mergeAudioMixPlan(recipe, defaults) {
  if (!defaults) {
    return recipe.audioMixPlan;
  }

  if (!recipe.audioMixPlan) {
    return defaults;
  }

  return {
    voiceTargetLufs: recipe.audioMixPlan.voiceTargetLufs ?? defaults.voiceTargetLufs,
    preWhisperNormalizeLufs: recipe.audioMixPlan.preWhisperNormalizeLufs ?? defaults.preWhisperNormalizeLufs,
    musicBed: recipe.audioMixPlan.musicBed ?? defaults.musicBed,
    segments: recipe.audioMixPlan.segments?.length
      ? recipe.audioMixPlan.segments
      : defaults.segments,
  };
}
