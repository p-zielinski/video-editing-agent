import fs from "node:fs";
import { runPythonScript } from "./python-bridge.js";
import {
  resolveTrackById,
  resolveTrackFilePath,
} from "../editorial/music-library.js";

function roundSec(value) {
  return Math.round(value * 1000) / 1000;
}

function beatsFromBpm(bpm, durationSec) {
  if (!Number.isFinite(bpm) || bpm <= 0 || durationSec <= 0) {
    return [];
  }
  const interval = 60 / bpm;
  const beats = [];
  let t = 0;
  while (t < durationSec) {
    beats.push(roundSec(t));
    t += interval;
  }
  return beats;
}

function barsFromBeats(beatsSec, beatsPerBar = 4) {
  const bars = [];
  for (let i = beatsPerBar - 1; i < beatsSec.length; i += beatsPerBar) {
    bars.push(beatsSec[i]);
  }
  return bars;
}

/**
 * Analyze music bed beat grid from catalog track or BPM fallback.
 * @param {string} trackId
 * @param {{ catalogPath?: string, maxDurationSec?: number }} [options]
 */
export async function analyzeMusicBeatGrid(trackId, {
  catalogPath,
  maxDurationSec = 120,
} = {}) {
  const { track } = resolveTrackById(trackId, { catalogPath });
  if (!track) {
    return null;
  }

  const durationSec = Math.min(track.durationSec ?? maxDurationSec, maxDurationSec);
  const filePath = resolveTrackFilePath(track, catalogPath);

  if (fs.existsSync(filePath)) {
    try {
      const analysis = await runPythonScript("audio_analyze.py", {
        audioPath: filePath,
        durationSec,
        stub: false,
      });
      const beatsSec = (analysis.beats ?? [])
        .map((beat) => roundSec(beat.timeSec))
        .filter((timeSec) => timeSec < durationSec);
      const bpm = analysis.estimatedBpm ?? track.bpm ?? 120;
      return {
        trackId,
        bpm,
        beatsSec,
        barSec: barsFromBeats(beatsSec),
        durationSec,
        source: analysis.analysisMode ?? "librosa",
      };
    } catch {
      // fall through to BPM synthetic grid
    }
  }

  const bpm = track.bpm ?? 120;
  const beatsSec = beatsFromBpm(bpm, durationSec);
  return {
    trackId,
    bpm,
    beatsSec,
    barSec: barsFromBeats(beatsSec),
    durationSec,
    source: "bpm_synthetic",
  };
}

/**
 * Resolve music beat grid for director brief from recipe/audio defaults.
 * @param {{ batchContext?: object, audioMixPlan?: object, audioIndex?: object }} params
 */
export async function resolveMusicBeatGridForBrief({
  batchContext = {},
  audioMixDefaults = null,
  audioMixPlan = null,
  audioIndex = null,
  musicSelection = null,
  catalogPath,
} = {}) {
  const hasShort = (batchContext.requiredFormats ?? []).includes("9:16")
    || (batchContext.outputs ?? []).some?.((output) => output.outputKind === "short");
  const musicFirst = batchContext.musicFirst === true;

  if (!hasShort && !musicFirst) {
    return null;
  }

  const trackId = musicSelection?.trackId
    ?? batchContext.musicBedTrackId
    ?? audioMixPlan?.musicBed?.trackId
    ?? audioMixDefaults?.musicBed?.trackId
    ?? audioIndex?.clips?.find((clip) => clip.recommendedTrackId)?.recommendedTrackId
    ?? "shorts_energy_01";

  const maxDurationSec = batchContext.shortsMaxDurationSec ?? 60;
  return analyzeMusicBeatGrid(trackId, { catalogPath, maxDurationSec });
}

/**
 * @param {number} timeSec
 * @param {number[]} beatsSec
 * @param {number} [maxDeltaSec=0.15]
 */
export function snapToNearestMusicBeat(timeSec, beatsSec, maxDeltaSec = 0.15) {
  if (!beatsSec?.length || !Number.isFinite(timeSec)) {
    return { snappedSec: timeSec, deltaSec: 0, snapped: false };
  }

  let best = beatsSec[0];
  let bestDelta = Math.abs(timeSec - best);
  for (const beat of beatsSec) {
    const delta = Math.abs(timeSec - beat);
    if (delta < bestDelta) {
      best = beat;
      bestDelta = delta;
    }
  }

  if (bestDelta > maxDeltaSec) {
    return { snappedSec: timeSec, deltaSec: 0, snapped: false };
  }

  return {
    snappedSec: roundSec(best),
    deltaSec: roundSec(best - timeSec),
    snapped: true,
  };
}
