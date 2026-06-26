/**
 * Maps AudioSet class labels (PANNs CNN14) to editorial tags for montage.
 */

/** @type {Array<{ match: RegExp, tag: string, category: string }>} */
export const AUDIO_LABEL_PATTERNS = [
  { match: /scream|shout|yell/i, tag: "scream", category: "reaction" },
  { match: /laugh/i, tag: "laughter", category: "reaction" },
  { match: /applause|clap/i, tag: "applause", category: "reaction" },
  { match: /cheer|crowd/i, tag: "crowd", category: "ambient" },
  { match: /squeak|creak|scrape|scratch/i, tag: "squeak", category: "foley" },
  { match: /slam|bang|thump|impact|crash|explosion/i, tag: "impact", category: "foley" },
  { match: /door|knock/i, tag: "door", category: "foley" },
  { match: /wind|breeze/i, tag: "wind", category: "ambient" },
  { match: /rain|thunder|storm/i, tag: "weather", category: "ambient" },
  { match: /traffic|vehicle|car|motor|horn|siren/i, tag: "traffic", category: "ambient" },
  { match: /music|song|singing|guitar|piano|drum/i, tag: "music", category: "music" },
  { match: /speech|narration|conversation|talk/i, tag: "speech", category: "voice" },
  { match: /silence/i, tag: "silence", category: "voice" },
  { match: /dog|bark/i, tag: "dog", category: "animal" },
  { match: /cat|meow/i, tag: "cat", category: "animal" },
  { match: /bird|chirp/i, tag: "bird", category: "animal" },
  { match: /beep|alarm|ringtone|notification|bell/i, tag: "alert", category: "foley" },
  { match: /breath|sigh|gasp/i, tag: "breath", category: "voice" },
  { match: /footstep|walk|run/i, tag: "footsteps", category: "foley" },
  { match: /water|splash|pour/i, tag: "water", category: "ambient" },
];

/**
 * @param {string | undefined | null} label
 * @returns {{ tag: string, category: string } | null}
 */
export function mapLabelToEditorialTag(label) {
  if (!label) {
    return null;
  }
  for (const pattern of AUDIO_LABEL_PATTERNS) {
    if (pattern.match.test(label)) {
      return { tag: pattern.tag, category: pattern.category };
    }
  }
  return null;
}

/**
 * @param {Array<{ label?: string, score?: number, startSec?: number, endSec?: number }>} events
 * @returns {Array<{ startSec: number, endSec: number, label: string, score: number, editorialTag?: string, category?: string }>}
 */
export function enrichAudioEvents(events = []) {
  return events.map((event) => {
    const mapped = mapLabelToEditorialTag(event.label);
    return {
      ...event,
      ...(mapped
        ? { editorialTag: mapped.tag, category: mapped.category }
        : {}),
    };
  });
}

/**
 * @param {Array<{ editorialTag?: string, category?: string, score?: number, startSec?: number, endSec?: number }>} events
 * @returns {Array<{ tag: string, category?: string, count: number, peakScore: number, totalDurationSec: number }>}
 */
export function rollupEditorialTags(events = []) {
  /** @type {Map<string, { tag: string, category?: string, count: number, peakScore: number, totalDurationSec: number }>} */
  const byTag = new Map();

  for (const event of events) {
    if (!event.editorialTag) {
      continue;
    }
    const duration = Math.max(0, (event.endSec ?? 0) - (event.startSec ?? 0));
    const existing = byTag.get(event.editorialTag);
    if (existing) {
      existing.count += 1;
      existing.peakScore = Math.max(existing.peakScore, event.score ?? 0);
      existing.totalDurationSec = Math.round((existing.totalDurationSec + duration) * 1000) / 1000;
    } else {
      byTag.set(event.editorialTag, {
        tag: event.editorialTag,
        category: event.category,
        count: 1,
        peakScore: event.score ?? 0,
        totalDurationSec: Math.round(duration * 1000) / 1000,
      });
    }
  }

  return [...byTag.values()].sort((a, b) => {
    if (b.peakScore !== a.peakScore) {
      return b.peakScore - a.peakScore;
    }
    return b.count - a.count;
  });
}

/**
 * @param {Array<{ tag: string }>} editorialTags
 * @param {number} [limit=6]
 * @returns {string[]}
 */
export function topEditorialTagNames(editorialTags = [], limit = 6) {
  return editorialTags.slice(0, limit).map((t) => t.tag);
}
