import { enrichAudioEvents, mapLabelToEditorialTag } from "./audio-event-tags.js";
import { mapSourceTimeToOutputSec } from "./shorts-retention.js";
import { resolveSfxByTag } from "./sfx-library.js";
import { resolveSfxDensityMaxEntries } from "../validators/recipe-v2.js";
import { COLD_OPEN_SEGMENT_ID } from "./chapter-hints.js";
import {
  findL2SegmentIdForSourceTime,
  resolveL2OutputRangeSec,
  resolveRecipeNarrativeProfile,
  resolveSegmentCaps,
} from "../lib/narrative-profile.js";

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
const ENRICH_MIN_EVENT_SCORE = 0.55;
const ENRICH_MAX_ENTRIES_PER_OUTPUT = 6;
const NARRATIVE_SFX_ANCHOR_TOLERANCE_SEC = 4;

/** @type {Record<string, string>} */
const LIBRARY_SFX_BY_TAG = {
  laughter: "laughter_short_01",
  scream: "impact_heavy_01",
  applause: "applause_short_01",
  impact: "impact_heavy_01",
  squeak: "click_short_01",
  door: "click_short_01",
  alert: "riser_short_01",
  crowd: "applause_short_01",
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
  const catalogMatch = resolveSfxByTag(tag);
  const sfxId = catalogMatch.sound?.sfxId
    ?? LIBRARY_SFX_BY_TAG[tag]
    ?? `library/sfx/${tag}`;
  const durationSec = catalogMatch.sound?.durationSec ?? 0.8;

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

function resolveMainOutput(recipe) {
  return (recipe?.outputs ?? []).find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function countSfxInL2Segment(sfxEntries, l2SegmentId, abstraction, recipe, wordIndexes) {
  const mainOutput = resolveMainOutput(recipe);
  if (!mainOutput) {
    return 0;
  }
  const range = resolveL2OutputRangeSec(
    l2SegmentId,
    abstraction,
    recipe,
    mainOutput,
    wordIndexes,
  );
  if (!range) {
    return 0;
  }
  return sfxEntries.filter((entry) => {
    const start = entry.outputStartSec ?? 0;
    return start >= range.startSec && start <= range.endSec;
  }).length;
}

function filterSfxCandidatesByL2Caps(
  candidates,
  existingSfx,
  recipe,
  { abstraction, timelineIndex, wordIndexes } = {},
) {
  if (!candidates.length) {
    return candidates;
  }

  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const hasL2Context = (abstraction?.L2 ?? []).length > 0;
  if (!narrativeProfile && !hasL2Context) {
    return candidates;
  }

  const accepted = [];
  const working = [...existingSfx];

  for (const candidate of candidates) {
    const anchorTimeSec = candidate.anchorTimeSec ?? candidate.outputStartSec;
    const l2SegmentId = findL2SegmentIdForSourceTime(
      abstraction,
      timelineIndex,
      candidate.clipId,
      anchorTimeSec,
    );
    if (!l2SegmentId) {
      accepted.push(candidate);
      working.push(candidate);
      continue;
    }

    const caps = resolveSegmentCaps(narrativeProfile, l2SegmentId, abstraction);
    if (!caps) {
      accepted.push(candidate);
      working.push(candidate);
      continue;
    }

    const count = countSfxInL2Segment(working, l2SegmentId, abstraction, recipe, wordIndexes);
    if (count >= caps.maxSfxEntries) {
      continue;
    }

    accepted.push(candidate);
    working.push(candidate);
  }

  return accepted;
}

function resolveClipRegistry(clipRegistry, recipe) {
  if (clipRegistry?.length) {
    return clipRegistry;
  }
  return recipe?.clipRegistry ?? [];
}

function isClipInRegistry(clipId, clipRegistry) {
  if (!clipId) {
    return false;
  }
  if (!clipRegistry.length) {
    return true;
  }
  return clipRegistry.some((entry) => entry.clipId === clipId);
}

function hasCatalogStubForTag(tag) {
  return resolveSfxByTag(tag).sound != null;
}

function isEventCoveredByExisting(candidate, existing) {
  return existing.some((entry) => {
    if (entry.clipId !== candidate.clipId || entry.label !== candidate.label) {
      return false;
    }
    if (candidate.anchorTimeSec == null || entry.anchorTimeSec == null) {
      return false;
    }
    return Math.abs(entry.anchorTimeSec - candidate.anchorTimeSec) < 0.5;
  });
}

function enrichMaxEntries(recipe, maxEntriesPerOutput) {
  const outputCount = Math.max(1, recipe?.outputs?.length ?? 1);
  return maxEntriesPerOutput * outputCount;
}

function sfxEntryScore(entry) {
  const match = entry.reason?.match(/score ([\d.]+)/);
  if (match) {
    return Number.parseFloat(match[1]);
  }
  return entry.source === "library" ? 0.5 : 0.55;
}

function collectNarrativeSfxAnchorRanges(recipe) {
  const ranges = [];

  for (const moment of recipe.creativeMoments ?? []) {
    if (moment.retentionRole === "hook" || moment.retentionRole === "payoff") {
      const start = moment.outputStartSec ?? moment.anchorSec ?? 0;
      const end = moment.outputEndSec ?? start + 3;
      ranges.push({
        startSec: start - NARRATIVE_SFX_ANCHOR_TOLERANCE_SEC,
        endSec: end + NARRATIVE_SFX_ANCHOR_TOLERANCE_SEC,
      });
    }
  }

  const mainOutput = recipe.outputs?.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
  for (const segment of mainOutput?.timeline ?? []) {
    if (segment.segmentId === COLD_OPEN_SEGMENT_ID) {
      ranges.push({
        startSec: segment.outputStartSec ?? 0,
        endSec: segment.outputEndSec ?? (segment.outputStartSec ?? 0) + 8,
      });
    }
  }

  return ranges;
}

function isNearNarrativeSfxAnchor(outputSec, anchorRanges) {
  return anchorRanges.some(
    (range) => outputSec >= range.startSec && outputSec <= range.endSec,
  );
}

function isNarrativeSfxCandidate(entry, recipe, anchorRanges, wordIndexes) {
  if (!entry.clipId || entry.anchorTimeSec == null) {
    return false;
  }
  const outputKind = resolveOutputKindForSfx(recipe, entry.outputId);
  const outputSec = mapSourceTimeToOutputSec(recipe, entry.clipId, entry.anchorTimeSec, {
    outputKind,
    wordIndexes,
  });
  if (outputSec == null || !Number.isFinite(outputSec)) {
    return false;
  }
  return isNearNarrativeSfxAnchor(outputSec, anchorRanges);
}

/**
 * Keep only SFX entries near narrative anchors when sfxNarrativeOnly is enabled.
 *
 * @param {object[]} sfxPlan
 * @param {object} recipe
 * @returns {object[]}
 */
export function filterSfxPlanForNarrativeOnly(sfxPlan, recipe, { wordIndexes } = {}) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (narrativeProfile?.sfxNarrativeOnly !== true) {
    return sfxPlan;
  }

  const anchorRanges = collectNarrativeSfxAnchorRanges(recipe);
  if (!anchorRanges.length) {
    return [];
  }

  return sfxPlan.filter((entry) => isNarrativeSfxCandidate(entry, recipe, anchorRanges, wordIndexes));
}

/**
 * V24-08 — sfxPlan entries outside narrative anchors when sfxNarrativeOnly is set.
 */
export function validateSfxNarrativeOnly(recipe, { wordIndexes } = {}) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (narrativeProfile?.sfxNarrativeOnly !== true) {
    return [];
  }

  const sfxPlan = recipe?.sfxPlan ?? [];
  if (!sfxPlan.length) {
    return [];
  }

  const anchorRanges = collectNarrativeSfxAnchorRanges(recipe);
  const issues = [];

  for (const entry of sfxPlan) {
    if (anchorRanges.length === 0 || !isNarrativeSfxCandidate(entry, recipe, anchorRanges, wordIndexes)) {
      issues.push({
        severity: "warning",
        code: "V24-08",
        message: `sfxPlan ${entry.sfxId}: poza zakresem anchorów narracyjnych (sfxNarrativeOnly)`,
      });
    }
  }

  return issues;
}

/**
 * Trim recipe.sfxPlan to V24-06 density cap (max ceil(mainDuration/90) on main).
 * Prefers director entries at the start of the plan; drops lowest-score enrich candidates.
 *
 * @param {object} recipe - EditRecipe with sfxPlan[]
 * @param {{ directorEntryCount?: number }} [options] - director entries merged before enrich candidates
 * @returns {object[]} trimmed sfxPlan
 */
export function trimSfxPlanToDensityCap(recipe, { directorEntryCount } = {}) {
  const sfxPlan = recipe?.sfxPlan ?? [];
  if (!sfxPlan.length) {
    return sfxPlan;
  }

  const maxEntries = resolveSfxDensityMaxEntries(recipe);
  if (!Number.isFinite(maxEntries) || sfxPlan.length <= maxEntries) {
    return sfxPlan;
  }

  const directorCount = directorEntryCount ?? sfxPlan.length;
  const directorEntries = sfxPlan.slice(0, directorCount);
  const enrichEntries = sfxPlan.slice(directorCount);
  const slotsForEnrich = Math.max(0, maxEntries - directorEntries.length);
  const keptEnrich = [...enrichEntries]
    .sort((a, b) => sfxEntryScore(b) - sfxEntryScore(a))
    .slice(0, slotsForEnrich);

  return [...directorEntries, ...keptEnrich];
}

/**
 * Merge high-confidence audio_event SFX into recipe.sfxPlan when director omitted them.
 * Preserves existing director entries; caps total plan at 6 entries per output.
 *
 * @param {object} recipe - EditRecipe v2 draft
 * @param {{ audioIndex?: object, clipRegistry?: object[], perClipAnalysis?: Map|object|array, maxEntriesPerOutput?: number, minEventScore?: number }} [options]
 * @returns {object[]} merged sfxPlan
 */
export function enrichRecipeSfxPlan(recipe, {
  audioIndex,
  clipRegistry,
  perClipAnalysis,
  maxEntriesPerOutput = ENRICH_MAX_ENTRIES_PER_OUTPUT,
  minEventScore = ENRICH_MIN_EVENT_SCORE,
  wordIndexes = null,
  abstraction = null,
  timelineIndex = null,
} = {}) {
  const existing = recipe?.sfxPlan ?? [];
  const registry = resolveClipRegistry(clipRegistry, recipe);
  const maxEntries = enrichMaxEntries(recipe, maxEntriesPerOutput);
  const slots = Math.max(0, maxEntries - existing.length);

  if (!audioIndex?.clips?.length || slots === 0) {
    return existing;
  }

  const candidates = buildSfxPlanFromAudio(audioIndex, {
    maxEntries: maxEntries * 4,
    minEventScore,
    perClipAnalysis,
  }).filter((entry) =>
    entry.source === "audio_event"
    && hasCatalogStubForTag(entry.label)
    && isClipInRegistry(entry.clipId, registry)
    && !isEventCoveredByExisting(entry, existing),
  );

  const eligibleCandidates = filterSfxPlanForNarrativeOnly(candidates, recipe, { wordIndexes });
  const cappedCandidates = filterSfxCandidatesByL2Caps(eligibleCandidates, existing, recipe, {
    abstraction,
    timelineIndex,
    wordIndexes,
  });

  const merged = [...existing, ...cappedCandidates.slice(0, slots)];
  return trimSfxPlanToDensityCap(
    {
      ...recipe,
      sfxPlan: remapSfxPlanToOutputTimeline({ ...recipe, sfxPlan: merged }, { wordIndexes }),
    },
    { directorEntryCount: existing.length },
  );
}

function resolveOutputKindForSfx(recipe, outputId) {
  if (!outputId) {
    return "main";
  }
  const output = (recipe.outputs ?? []).find((entry) => entry.outputId === outputId);
  return output?.outputKind ?? (output?.format === "9:16" ? "short" : "main");
}

/**
 * Remap sfxPlan anchor/output times from source clip time to output timeline.
 *
 * @param {object} recipe
 * @returns {object[]}
 */
export function remapSfxPlanToOutputTimeline(recipe, { wordIndexes } = {}) {
  const sfxPlan = recipe?.sfxPlan ?? [];
  if (!sfxPlan.length || !(recipe.outputs ?? []).length) {
    return sfxPlan;
  }

  return sfxPlan.map((entry) => {
    if (entry.source !== "audio_event" || !entry.clipId || entry.anchorTimeSec == null) {
      return entry;
    }

    const outputKind = resolveOutputKindForSfx(recipe, entry.outputId);
    const mappedStart = mapSourceTimeToOutputSec(recipe, entry.clipId, entry.anchorTimeSec, {
      outputKind,
      wordIndexes,
    });
    if (mappedStart == null || !Number.isFinite(mappedStart)) {
      return entry;
    }

    const durationSec = Math.max(0.1, (entry.outputEndSec ?? entry.anchorTimeSec) - (entry.outputStartSec ?? entry.anchorTimeSec));
    return {
      ...entry,
      outputStartSec: mappedStart,
      outputEndSec: Math.round((mappedStart + durationSec) * 10) / 10,
    };
  });
}
