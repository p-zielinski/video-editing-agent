import { summarizeMusicLibraryForIndex } from "./music-library.js";

export const DEFAULT_AUDIO_CAPS = {
  cutSuggestions: 8,
  silenceGaps: 5,
  energyPeaks: 5,
  audioEvents: 6,
  deadAirHints: 6,
};

/** Higher caps for director brief — critic/fixer keep DEFAULT_AUDIO_CAPS. */
export const DIRECTOR_AUDIO_CAPS = {
  cutSuggestions: 12,
  silenceGaps: 8,
  energyPeaks: 8,
  audioEvents: 10,
  deadAirHints: 10,
};

const MIN_DEAD_AIR_GAP_SEC = 0.5;

export const SILENCE_KINDS = ["dead_air", "dramatic_pause", "breath_before_punchline"];

const DRAMATIC_PAUSE_MIN_SEC = 2;
const BREATH_MAX_GAP_SEC = 2;
const HIGH_ENERGY_RMS_DB = -20;
const LOW_RMS_DB = -38;
const MONO_RMS_SPREAD_DB = 8;
const ENERGY_LOOKBACK_SEC = 4;
const ENERGY_WINDOW_SEC = 6;

const DRAMATIC_MOODS = new Set(["dramatic", "cinematic", "documentary", "serious"]);
const COMEDY_MOODS = new Set(["comedy", "humor", "humorous", "funny"]);

function lookupPerClipAnalysis(clipId, perClipAnalysis) {
  if (!perClipAnalysis) {
    return null;
  }
  if (perClipAnalysis instanceof Map) {
    return perClipAnalysis.get(clipId) ?? null;
  }
  if (Array.isArray(perClipAnalysis)) {
    return perClipAnalysis.find((entry) => entry.clipId === clipId) ?? null;
  }
  if (typeof perClipAnalysis === "object") {
    return perClipAnalysis[clipId] ?? null;
  }
  return null;
}

export function lookupWordIndex(clipId, wordIndexes, timelineIndex) {
  if (Array.isArray(wordIndexes)) {
    const found = wordIndexes.find((entry) => entry.clipId === clipId);
    if (found?.words?.length) {
      return found;
    }
  }

  if (timelineIndex?.words?.length) {
    const words = timelineIndex.words
      .filter((word) => word.wordId.startsWith(`${clipId}_`))
      .sort((a, b) => a.start - b.start);
    if (words.length > 0) {
      const clip = timelineIndex.clips?.find((entry) => entry.clipId === clipId);
      return {
        clipId,
        words,
        durationSec: clip?.durationSec ?? words.at(-1).end,
      };
    }
  }

  return null;
}

function gapDurationSec(gap) {
  return (gap.endSec ?? 0) - (gap.startSec ?? 0);
}

function rmsInRange(energyCurve, startSec, endSec) {
  const values = [];
  for (const point of energyCurve ?? []) {
    if (point.endSec <= startSec || point.startSec >= endSec) {
      continue;
    }
    values.push(point.rmsDb);
  }
  return values;
}

function maxRmsInRange(energyCurve, startSec, endSec) {
  const values = rmsInRange(energyCurve, startSec, endSec);
  return values.length > 0 ? Math.max(...values) : null;
}

function avgRmsInRange(energyCurve, startSec, endSec) {
  const values = rmsInRange(energyCurve, startSec, endSec);
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rmsSpreadInRange(energyCurve, startSec, endSec) {
  const values = rmsInRange(energyCurve, startSec, endSec);
  if (values.length < 2) {
    return null;
  }
  return Math.max(...values) - Math.min(...values);
}

function wordAfterGap(gap, wordIndex) {
  if (!wordIndex?.words?.length) {
    return null;
  }
  const words = [...wordIndex.words].sort((a, b) => a.start - b.start);
  return words.find((word) => word.start >= gap.endSec - 0.05) ?? null;
}

function wordBeforeGap(gap, wordIndex) {
  if (!wordIndex?.words?.length) {
    return null;
  }
  const words = [...wordIndex.words].sort((a, b) => a.start - b.start);
  let previous = null;
  for (const word of words) {
    if (word.end <= gap.startSec + 0.05) {
      previous = word;
    }
  }
  return previous;
}

function hasHighEnergyBeforeGap(gap, energyCurve) {
  const peak = maxRmsInRange(
    energyCurve,
    Math.max(0, gap.startSec - ENERGY_LOOKBACK_SEC),
    gap.startSec,
  );
  return peak != null && peak >= HIGH_ENERGY_RMS_DB;
}

function isMonotoneAroundGap(gap, energyCurve) {
  const spread = rmsSpreadInRange(
    energyCurve,
    Math.max(0, gap.startSec - ENERGY_WINDOW_SEC),
    gap.endSec + 2,
  );
  return spread != null && spread <= MONO_RMS_SPREAD_DB;
}

function isBreathBeforePunchline(gap, energyCurve, wordIndex) {
  const duration = gapDurationSec(gap);
  if (duration > BREATH_MAX_GAP_SEC || duration <= MIN_DEAD_AIR_GAP_SEC) {
    return false;
  }

  const after = wordAfterGap(gap, wordIndex);
  const before = wordBeforeGap(gap, wordIndex);
  if (!after || !before) {
    return false;
  }

  const gapRms = avgRmsInRange(energyCurve, gap.startSec, gap.endSec);
  const afterRms = maxRmsInRange(energyCurve, after.start, after.end + 0.2);
  const lowGapRms = gapRms == null || gapRms <= LOW_RMS_DB;
  const punchlineLift = afterRms != null && afterRms >= HIGH_ENERGY_RMS_DB;
  return lowGapRms || punchlineLift;
}

/**
 * Deterministic silence taxonomy for fused dead-air hints.
 */
export function classifySilenceKind(
  gap,
  {
    wordIndex = null,
    energyCurve = [],
    dominantMood = null,
    narrativeProfile = null,
  } = {},
) {
  const duration = gapDurationSec(gap);
  const policy = narrativeProfile?.silencePolicy ?? null;
  const mood = dominantMood?.toLowerCase?.() ?? null;

  if (policy === "preserve") {
    if (duration > DRAMATIC_PAUSE_MIN_SEC || hasHighEnergyBeforeGap(gap, energyCurve)) {
      return "dramatic_pause";
    }
    if (isBreathBeforePunchline(gap, energyCurve, wordIndex)) {
      return "breath_before_punchline";
    }
    return "dramatic_pause";
  }

  if (
    duration > DRAMATIC_PAUSE_MIN_SEC
    && (hasHighEnergyBeforeGap(gap, energyCurve) || (mood && DRAMATIC_MOODS.has(mood)))
  ) {
    return "dramatic_pause";
  }

  if (
    isBreathBeforePunchline(gap, energyCurve, wordIndex)
    || (mood && COMEDY_MOODS.has(mood) && duration <= BREATH_MAX_GAP_SEC && wordAfterGap(gap, wordIndex))
  ) {
    return "breath_before_punchline";
  }

  if (isMonotoneAroundGap(gap, energyCurve) || policy === "aggressive") {
    return "dead_air";
  }

  return "dead_air";
}

export function tagDeadAirHintsWithSilenceKind(
  hints,
  {
    wordIndex = null,
    energyCurve = [],
    dominantMood = null,
    narrativeProfile = null,
  } = {},
) {
  return (hints ?? []).map((hint) => {
    if (hint.silenceKind) {
      return hint;
    }
    return {
      ...hint,
      silenceKind: classifySilenceKind(hint, {
        wordIndex,
        energyCurve,
        dominantMood,
        narrativeProfile,
      }),
    };
  });
}

function findTranscriptGaps(wordIndex) {
  if (!wordIndex?.words?.length) {
    return [];
  }

  const words = [...wordIndex.words].sort((a, b) => a.start - b.start);
  const durationSec = wordIndex.durationSec ?? words.at(-1).end;
  const gaps = [];

  if (words[0].start >= MIN_DEAD_AIR_GAP_SEC) {
    gaps.push({ startSec: 0, endSec: words[0].start });
  }

  for (let index = 0; index < words.length - 1; index += 1) {
    const startSec = words[index].end;
    const endSec = words[index + 1].start;
    if (gapDurationSec({ startSec, endSec }) > MIN_DEAD_AIR_GAP_SEC) {
      gaps.push({ startSec, endSec });
    }
  }

  const lastEndSec = words.at(-1).end;
  if (durationSec - lastEndSec > MIN_DEAD_AIR_GAP_SEC) {
    gaps.push({ startSec: lastEndSec, endSec: durationSec });
  }

  return gaps;
}

function intervalsOverlap(a, b) {
  return a.startSec < b.endSec && b.startSec < a.endSec;
}

function sourceFromSet(sources) {
  if (sources.has("audio") && sources.has("transcript")) {
    return "both";
  }
  if (sources.has("audio")) {
    return "audio";
  }
  return "transcript";
}

/**
 * Merge RMS silence gaps with Whisper no-speech gaps (>0.5 s).
 */
export function fuseDeadAirHints(perClipAnalysis, wordIndex, limit = DEFAULT_AUDIO_CAPS.deadAirHints) {
  const audioGaps = (perClipAnalysis?.silenceGaps ?? [])
    .filter((gap) => gapDurationSec(gap) > MIN_DEAD_AIR_GAP_SEC)
    .map((gap) => ({
      startSec: gap.startSec,
      endSec: gap.endSec,
      sources: new Set(["audio"]),
    }));

  const transcriptGaps = findTranscriptGaps(wordIndex).map((gap) => ({
    startSec: gap.startSec,
    endSec: gap.endSec,
    sources: new Set(["transcript"]),
  }));

  const tagged = [...audioGaps, ...transcriptGaps]
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const merged = [];
  for (const interval of tagged) {
    const previous = merged.at(-1);
    if (previous && interval.startSec < previous.endSec) {
      previous.endSec = Math.max(previous.endSec, interval.endSec);
      for (const source of interval.sources) {
        previous.sources.add(source);
      }
      continue;
    }

    merged.push({
      startSec: interval.startSec,
      endSec: interval.endSec,
      sources: new Set(interval.sources),
    });
  }

  return merged
    .filter((gap) => gapDurationSec(gap) > MIN_DEAD_AIR_GAP_SEC)
    .sort((a, b) => gapDurationSec(b) - gapDurationSec(a))
    .slice(0, limit)
    .map(({ startSec, endSec, sources }) => ({
      startSec,
      endSec,
      source: sourceFromSet(sources),
    }));
}

function topCutSuggestions(cuts, limit = DEFAULT_AUDIO_CAPS.cutSuggestions) {
  return [...(cuts ?? [])]
    .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
    .slice(0, limit)
    .map(({ timeSec, reason, strength }) => ({ timeSec, reason, strength }));
}

function topSilenceGaps(gaps, limit = DEFAULT_AUDIO_CAPS.silenceGaps) {
  return [...(gaps ?? [])]
    .sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0))
    .slice(0, limit)
    .map(({ startSec, endSec, durationSec }) => ({ startSec, endSec, durationSec }));
}

function topEnergyPeaks(curve, limit = DEFAULT_AUDIO_CAPS.energyPeaks) {
  return [...(curve ?? [])]
    .sort((a, b) => (b.rmsDb ?? -Infinity) - (a.rmsDb ?? -Infinity))
    .slice(0, limit)
    .map(({ startSec, endSec, rmsDb }) => ({ startSec, endSec, rmsDb }));
}

function topAudioEvents(events, limit = DEFAULT_AUDIO_CAPS.audioEvents) {
  return [...(events ?? [])]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit)
    .map(({ startSec, label, score }) => ({
      timeSec: startSec,
      label,
      strength: score,
    }));
}

function enrichClipFromAnalysis(clip, perClipAnalysis, caps = DEFAULT_AUDIO_CAPS) {
  const analysis = lookupPerClipAnalysis(clip.clipId, perClipAnalysis);
  const enriched = {};

  const cutSuggestions = topCutSuggestions(
    analysis?.cutSuggestions ?? clip.cutSuggestions,
    caps.cutSuggestions,
  );
  if (cutSuggestions.length > 0) {
    enriched.cutSuggestions = cutSuggestions;
  }

  const silenceGaps = topSilenceGaps(
    analysis?.silenceGaps ?? clip.silenceGaps,
    caps.silenceGaps,
  );
  if (silenceGaps.length > 0) {
    enriched.silenceGaps = silenceGaps;
  }

  const energyPeaks = topEnergyPeaks(
    analysis?.energyCurve ?? clip.energyCurve,
    caps.energyPeaks,
  );
  if (energyPeaks.length > 0) {
    enriched.energyPeaks = energyPeaks;
  }

  const audioEvents = topAudioEvents(
    analysis?.audioEvents ?? clip.audioEvents,
    caps.audioEvents,
  );
  if (audioEvents.length > 0) {
    enriched.audioEvents = audioEvents;
  }

  return enriched;
}

function filterMusicLibraryTracks(musicLibrary) {
  const available = summarizeMusicLibraryForIndex();
  const availableIds = new Set(available.tracks.map((track) => track.trackId));

  if (!musicLibrary?.tracks?.length) {
    return available.trackCount > 0 ? available : musicLibrary;
  }

  const tracks = musicLibrary.tracks.filter((track) => availableIds.has(track.trackId));
  return {
    trackCount: tracks.length,
    tracks,
  };
}

/**
 * Compact audio index summary for director/critic LLM payloads.
 * @param {object|null} audioIndex - 05d-audio-index rollup
 * @param {{ perClipAnalysis?: Map|object|array, wordIndexes?: array, timelineIndex?: object, caps?: object }} [options]
 */
export function buildAudioIndexSummary(
  audioIndex,
  {
    perClipAnalysis,
    wordIndexes,
    timelineIndex,
    caps = DEFAULT_AUDIO_CAPS,
    narrativeProfile = null,
  } = {},
) {
  if (!audioIndex?.clips?.length) {
    return undefined;
  }

  return {
    clipCount: audioIndex.clips.length,
    batchSummary: audioIndex.batchSummary,
    clips: audioIndex.clips.map((clip) => {
      const analysis = lookupPerClipAnalysis(clip.clipId, perClipAnalysis);
      const wordIndex = lookupWordIndex(clip.clipId, wordIndexes, timelineIndex);
      const fusedHints = fuseDeadAirHints(analysis, wordIndex, caps.deadAirHints);
      const rawHints = fusedHints.length > 0
        ? fusedHints
        : (clip.deadAirHints ?? []);
      const deadAirHints = tagDeadAirHintsWithSilenceKind(rawHints, {
        wordIndex,
        energyCurve: analysis?.energyCurve ?? clip.energyCurve ?? [],
        dominantMood: audioIndex.batchSummary?.dominantMood ?? null,
        narrativeProfile,
      });
      const enriched = enrichClipFromAnalysis(clip, perClipAnalysis, caps);

      return {
        clipId: clip.clipId,
        voiceLufs: clip.voiceLufs,
        beatCount: clip.beatCount,
        beatTimestamps: clip.beatTimes ?? [],
        silenceGapCount: clip.silenceGapCount,
        totalSilenceSec: clip.totalSilenceSec,
        recommendedTrackId: clip.recommendedTrackId ?? null,
        estimatedBpm: clip.estimatedBpm,
        audioEventCount: clip.audioEventCount ?? 0,
        editorialTags: clip.editorialTags ?? [],
        ...(deadAirHints.length > 0 ? { deadAirHints } : {}),
        ...enriched,
      };
    }),
    musicLibrary: filterMusicLibraryTracks(audioIndex.musicLibrary),
  };
}
