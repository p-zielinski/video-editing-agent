import { summarizeMusicLibraryForIndex } from "./music-library.js";

const TOP_CUT_SUGGESTIONS = 8;
const TOP_SILENCE_GAPS = 5;
const TOP_ENERGY_PEAKS = 5;
const TOP_AUDIO_EVENTS = 6;
const TOP_DEAD_AIR_HINTS = 6;
const MIN_DEAD_AIR_GAP_SEC = 0.5;

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
export function fuseDeadAirHints(perClipAnalysis, wordIndex) {
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
    .slice(0, TOP_DEAD_AIR_HINTS)
    .map(({ startSec, endSec, sources }) => ({
      startSec,
      endSec,
      source: sourceFromSet(sources),
    }));
}

function topCutSuggestions(cuts, limit = TOP_CUT_SUGGESTIONS) {
  return [...(cuts ?? [])]
    .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
    .slice(0, limit)
    .map(({ timeSec, reason, strength }) => ({ timeSec, reason, strength }));
}

function topSilenceGaps(gaps, limit = TOP_SILENCE_GAPS) {
  return [...(gaps ?? [])]
    .sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0))
    .slice(0, limit)
    .map(({ startSec, endSec, durationSec }) => ({ startSec, endSec, durationSec }));
}

function topEnergyPeaks(curve, limit = TOP_ENERGY_PEAKS) {
  return [...(curve ?? [])]
    .sort((a, b) => (b.rmsDb ?? -Infinity) - (a.rmsDb ?? -Infinity))
    .slice(0, limit)
    .map(({ startSec, endSec, rmsDb }) => ({ startSec, endSec, rmsDb }));
}

function topAudioEvents(events, limit = TOP_AUDIO_EVENTS) {
  return [...(events ?? [])]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit)
    .map(({ startSec, label, score }) => ({
      timeSec: startSec,
      label,
      strength: score,
    }));
}

function enrichClipFromAnalysis(clip, perClipAnalysis) {
  const analysis = lookupPerClipAnalysis(clip.clipId, perClipAnalysis);
  const enriched = {};

  const cutSuggestions = topCutSuggestions(
    analysis?.cutSuggestions ?? clip.cutSuggestions,
  );
  if (cutSuggestions.length > 0) {
    enriched.cutSuggestions = cutSuggestions;
  }

  const silenceGaps = topSilenceGaps(
    analysis?.silenceGaps ?? clip.silenceGaps,
  );
  if (silenceGaps.length > 0) {
    enriched.silenceGaps = silenceGaps;
  }

  const energyPeaks = topEnergyPeaks(
    analysis?.energyCurve ?? clip.energyCurve,
  );
  if (energyPeaks.length > 0) {
    enriched.energyPeaks = energyPeaks;
  }

  const audioEvents = topAudioEvents(
    analysis?.audioEvents ?? clip.audioEvents,
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
 * @param {{ perClipAnalysis?: Map|object|array, wordIndexes?: array, timelineIndex?: object }} [options]
 */
export function buildAudioIndexSummary(
  audioIndex,
  { perClipAnalysis, wordIndexes, timelineIndex } = {},
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
      const deadAirHints = fuseDeadAirHints(analysis, wordIndex);
      const enriched = enrichClipFromAnalysis(clip, perClipAnalysis);

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
