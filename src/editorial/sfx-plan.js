import { enrichAudioEvents, mapLabelToEditorialTag } from "./audio-event-tags.js";

/** Editorial tags worth surfacing as SFX plan entries (excludes speech, music, silence). */
const SFX_WORTHY_TAGS = new Set([
  "laughter",
  "scream",
  "applause",
  "impact",
  "squeak",
  "door",
  "alert",
  "crowd",
  "breath",
  "footsteps",
  "dog",
  "cat",
  "bird",
]);

const DEFAULT_MIN_EVENT_SCORE = 0.45;
const DEFAULT_MAX_ENTRIES = 20;

/** @type {Record<string, string>} */
const LIBRARY_SFX_BY_TAG = {
  laughter: "library/sfx/laughter",
  scream: "library/sfx/scream",
  applause: "library/sfx/applause",
  impact: "library/sfx/impact",
  squeak: "library/sfx/squeak",
  door: "library/sfx/door",
  alert: "library/sfx/alert",
  crowd: "library/sfx/crowd",
};

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

function resolveEditorialTag(event) {
  if (event.editorialTag) {
    return event.editorialTag;
  }
  return mapLabelToEditorialTag(event.label)?.tag ?? null;
}

function isWorthyTag(tag) {
  return tag != null && SFX_WORTHY_TAGS.has(tag);
}

function eventStrength(event) {
  return event.score ?? event.strength ?? 0;
}

function makeAudioEventEntry(clipId, event, tag) {
  const startSec = event.startSec ?? event.timeSec ?? 0;
  const endSec = event.endSec ?? startSec + 0.4;
  const durationSec = Math.max(0.1, endSec - startSec);

  return {
    sfxId: `evt_${clipId}_${Math.round(startSec * 1000)}`,
    source: "audio_event",
    clipId,
    anchorTimeSec: startSec,
    outputStartSec: startSec,
    outputEndSec: startSec + durationSec,
    volumeDb: -6,
    label: tag,
    reason: `Detected ${event.label ?? tag} (score ${eventStrength(event).toFixed(2)})`,
  };
}

function makeLibraryEntry(tag, clipId, anchorTimeSec = 0) {
  const sfxId = LIBRARY_SFX_BY_TAG[tag] ?? `library/sfx/${tag}`;
  const durationSec = 0.8;

  return {
    sfxId,
    source: "library",
    ...(clipId ? { clipId } : {}),
    ...(anchorTimeSec != null ? { anchorTimeSec } : {}),
    outputStartSec: anchorTimeSec,
    outputEndSec: anchorTimeSec + durationSec,
    volumeDb: -6,
    label: tag,
    reason: `Editorial tag suggestion: ${tag}`,
  };
}

function collectClipEvents(clip, perClipAnalysis) {
  const analysis = lookupPerClipAnalysis(clip.clipId, perClipAnalysis);
  const rawEvents = analysis?.audioEvents ?? clip.audioEvents ?? [];
  return enrichAudioEvents(rawEvents);
}

function collectEditorialTagNames(clip, perClipAnalysis) {
  const analysis = lookupPerClipAnalysis(clip.clipId, perClipAnalysis);
  const tags = analysis?.editorialTags ?? clip.editorialTags ?? [];

  return tags.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    return entry.tag;
  }).filter(Boolean);
}

/**
 * Build sfxPlan[] entries from audio index rollups and per-clip audio analysis.
 * Timed events use source `audio_event`; clip-level tags without timing fall back to `library`.
 *
 * @param {object|null} audioIndex - 05d-audio-index artifact
 * @param {{ maxEntries?: number, minEventScore?: number, perClipAnalysis?: Map|object|array }} [options]
 */
export function buildSfxPlanFromAudio(audioIndex, { maxEntries = DEFAULT_MAX_ENTRIES, minEventScore = DEFAULT_MIN_EVENT_SCORE, perClipAnalysis } = {}) {
  if (!audioIndex?.clips?.length) {
    return [];
  }

  /** @type {Array<{ entry: object, rank: number }>} */
  const candidates = [];
  const coveredTags = new Set();

  for (const clip of audioIndex.clips) {
    const events = collectClipEvents(clip, perClipAnalysis);

    for (const event of events) {
      const tag = resolveEditorialTag(event);
      if (!isWorthyTag(tag)) {
        continue;
      }
      const strength = eventStrength(event);
      if (strength < minEventScore) {
        continue;
      }

      coveredTags.add(`${clip.clipId}:${tag}`);
      candidates.push({
        entry: makeAudioEventEntry(clip.clipId, event, tag),
        rank: strength,
      });
    }

    for (const tag of collectEditorialTagNames(clip, perClipAnalysis)) {
      if (!isWorthyTag(tag) || coveredTags.has(`${clip.clipId}:${tag}`)) {
        continue;
      }

      const analysis = lookupPerClipAnalysis(clip.clipId, perClipAnalysis);
      const peakScore = analysis?.editorialTags?.find((t) => t.tag === tag)?.peakScore ?? 0.55;
      candidates.push({
        entry: makeLibraryEntry(tag, clip.clipId, 0),
        rank: peakScore,
      });
    }
  }

  return candidates
    .sort((a, b) => b.rank - a.rank)
    .slice(0, maxEntries)
    .map((candidate) => candidate.entry);
}
