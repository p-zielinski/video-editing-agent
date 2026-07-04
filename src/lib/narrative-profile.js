/**
 * Resolve L2 narrative profile controls for enrichers and director brief.
 */

import { buildOutputTimeline } from "./build-output-timeline.js";
import { mapSourceTimeToOutputSec } from "../editorial/shorts-retention.js";

const NARRATIVE_ROLE_PROFILE_DEFAULTS = {
  setup: { rhythm: "normal", retentionIntensity: "medium" },
  development: { rhythm: "normal", retentionIntensity: "medium" },
  breath: { rhythm: "slow", retentionIntensity: "low", silencePolicy: "preserve" },
  climax: { rhythm: "normal", retentionIntensity: "medium" },
  payoff: { rhythm: "normal", retentionIntensity: "medium" },
  tension: { rhythm: "fast", retentionIntensity: "high" },
  resolution: { rhythm: "slow", retentionIntensity: "low" },
};

/** Default enrich caps keyed by L2 rhythm (overridable per segment in narrativeProfile). */
export const RHYTHM_CAPS = {
  slow: {
    maxRetentionBeats: 0,
    maxEnrichBeats: 0,
    maxSfxEntries: 0,
    allowPatternInterrupt: false,
    allowChapterCards: false,
  },
  normal: {
    maxRetentionBeats: 1,
    maxEnrichBeats: 1,
    maxSfxEntries: 2,
    allowPatternInterrupt: false,
    allowChapterCards: true,
  },
  fast: {
    maxRetentionBeats: 2,
    maxEnrichBeats: 2,
    maxSfxEntries: 3,
    allowPatternInterrupt: true,
    allowChapterCards: true,
  },
};

/**
 * Derive per-L2 narrativeProfile segment controls from summarizer narrativeRole tags.
 * When `existingProfile` is provided, top-level fields are preserved and segments are
 * merged by l2SegmentId (existing segment entries win over L2 defaults).
 * Returns null when there are no mapped L2 roles and no existing profile.
 */
export function buildNarrativeProfileFromL2Roles(abstraction, existingProfile = null) {
  const l2Segments = [];

  for (const segment of abstraction?.L2 ?? []) {
    const defaults = NARRATIVE_ROLE_PROFILE_DEFAULTS[segment.narrativeRole];
    if (!defaults) {
      continue;
    }
    l2Segments.push({
      l2SegmentId: segment.segmentId,
      ...defaults,
    });
  }

  if (l2Segments.length === 0) {
    return existingProfile ?? null;
  }

  if (!existingProfile) {
    return { segments: l2Segments };
  }

  const existingById = new Map(
    (existingProfile.segments ?? []).map((entry) => [entry.l2SegmentId, entry]),
  );
  const mergedSegments = [];
  const seen = new Set();

  for (const l2Entry of l2Segments) {
    mergedSegments.push(existingById.get(l2Entry.l2SegmentId) ?? l2Entry);
    seen.add(l2Entry.l2SegmentId);
  }
  for (const entry of existingProfile.segments ?? []) {
    if (!seen.has(entry.l2SegmentId)) {
      mergedSegments.push(entry);
    }
  }

  return {
    ...existingProfile,
    segments: mergedSegments,
  };
}

/**
 * Resolve narrativeProfile for director brief/recipe: explicit recipe/batch profile
 * merged with L2 narrativeRole defaults when segments are missing.
 */
export function resolveEffectiveNarrativeProfile({
  narrativeProfile = null,
  batchContext = {},
  recipe = null,
  abstraction = null,
} = {}) {
  const explicit = narrativeProfile
    ?? batchContext.narrativeProfile
    ?? resolveRecipeNarrativeProfile(recipe);
  return buildNarrativeProfileFromL2Roles(abstraction, explicit) ?? explicit ?? null;
}

export function resolveL2SegmentProfile(narrativeProfile, l2SegmentId) {
  if (!narrativeProfile?.segments?.length || !l2SegmentId) {
    return null;
  }
  return narrativeProfile.segments.find((entry) => entry.l2SegmentId === l2SegmentId) ?? null;
}

/**
 * Resolve per-L2 enrich caps from narrativeProfile segment rhythm (or L2 narrativeRole fallback).
 * Returns null when rhythm cannot be determined.
 */
export function resolveSegmentCaps(narrativeProfile, l2SegmentId, abstraction = null) {
  if (!l2SegmentId) {
    return null;
  }

  const segmentProfile = narrativeProfile
    ? resolveL2SegmentProfile(narrativeProfile, l2SegmentId)
    : null;
  const l2Segment = (abstraction?.L2 ?? []).find((entry) => entry.segmentId === l2SegmentId);

  let rhythm = segmentProfile?.rhythm;
  if (!rhythm && l2Segment?.narrativeRole) {
    rhythm = NARRATIVE_ROLE_PROFILE_DEFAULTS[l2Segment.narrativeRole]?.rhythm;
  }
  if (!rhythm) {
    return null;
  }

  const defaults = RHYTHM_CAPS[rhythm];
  if (!defaults) {
    return null;
  }

  return {
    rhythm,
    maxRetentionBeats: segmentProfile?.maxRetentionBeats ?? defaults.maxRetentionBeats,
    maxEnrichBeats: segmentProfile?.maxEnrichBeats ?? defaults.maxEnrichBeats,
    maxSfxEntries: segmentProfile?.maxSfxEntries ?? defaults.maxSfxEntries,
    allowPatternInterrupt: segmentProfile?.allowPatternInterrupt ?? defaults.allowPatternInterrupt,
    allowChapterCards: segmentProfile?.allowChapterCards ?? defaults.allowChapterCards,
  };
}

export function resolveRecipeNarrativeProfile(recipe) {
  return recipe?.narrativeProfile ?? recipe?.batchContext?.narrativeProfile ?? null;
}

/**
 * Map clip source time to L2 segmentId via scene membership or L2 time range.
 */
export function findL2SegmentIdForSourceTime(abstraction, timelineIndex, clipId, sourceTimeSec) {
  if (!Number.isFinite(sourceTimeSec)) {
    return null;
  }

  const scene = (timelineIndex?.scenes ?? []).find(
    (entry) => entry.clipId === clipId
      && sourceTimeSec >= entry.startSec
      && sourceTimeSec < entry.endSec,
  );

  if (scene) {
    for (const segment of abstraction?.L2 ?? []) {
      if ((segment.sceneIds ?? []).includes(scene.sceneId)) {
        return segment.segmentId;
      }
    }
  }

  for (const segment of abstraction?.L2 ?? []) {
    if (
      segment.startSec != null
      && segment.endSec != null
      && sourceTimeSec >= segment.startSec
      && sourceTimeSec < segment.endSec
    ) {
      return segment.segmentId;
    }
  }

  return null;
}

export function shouldSkipRetentionBeatEnrich(segmentProfile) {
  if (!segmentProfile) {
    return false;
  }
  return segmentProfile.retentionIntensity === "low"
    || segmentProfile.rhythm === "slow";
}

/**
 * Slow/low narrativeProfile segment or L2 breath role — exempt from beat min/gap rules.
 */
export function isSlowBreathNarrativeSegment(segmentProfile, abstractionSegment) {
  if (abstractionSegment?.narrativeRole === "breath") {
    return true;
  }
  return shouldSkipRetentionBeatEnrich(segmentProfile);
}

/**
 * Map L2 segment to output time range on main.
 */
export function resolveL2OutputRangeSec(l2SegmentId, abstraction, recipe, mainOutput, wordIndexes) {
  const segment = (abstraction?.L2 ?? []).find((entry) => entry.segmentId === l2SegmentId);
  if (!segment) {
    return null;
  }

  const sceneIds = new Set(segment.sceneIds ?? []);
  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  const matching = enrichedTimeline.filter(
    (entry) => sceneIds.has(entry.videoRef?.sceneId) || sceneIds.has(entry.audioRef?.sceneId),
  );
  if (matching.length) {
    const start = Math.min(...matching.map((entry) => entry.outputStartSec ?? 0));
    const end = Math.max(...matching.map((entry) => entry.outputEndSec ?? start));
    return { startSec: start, endSec: end };
  }

  const sceneId = segment.sceneIds?.[0];
  if (!sceneId || segment.startSec == null || segment.endSec == null) {
    return null;
  }

  const clipId = sceneId.match(/^(.+)_scene\d+$/)?.[1] ?? sceneId.split("_")[0];
  const outStart = mapSourceTimeToOutputSec(recipe, clipId, segment.startSec, {
    outputKind: "main",
    wordIndexes,
  });
  const outEnd = mapSourceTimeToOutputSec(
    recipe,
    clipId,
    Math.max(segment.startSec, segment.endSec - 0.001),
    { outputKind: "main", wordIndexes },
  );
  if (outStart == null || outEnd == null) {
    return null;
  }

  return { startSec: outStart, endSec: outEnd };
}

export function mergeOutputRanges(ranges) {
  if (!ranges?.length) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const current = sorted[i];
    if (current.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, current.endSec);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

export function computeExemptDurationSec(exemptRanges) {
  return mergeOutputRanges(exemptRanges).reduce(
    (sum, range) => sum + (range.endSec - range.startSec),
    0,
  );
}

/**
 * Gap length after subtracting slow/breath exempt spans overlapping [gapStart, gapEnd].
 */
export function effectiveGapSec(gapStart, gapEnd, exemptRanges) {
  const gapLength = gapEnd - gapStart;
  if (!exemptRanges?.length || gapLength <= 0) {
    return gapLength;
  }

  let exemptInGap = 0;
  for (const range of mergeOutputRanges(exemptRanges)) {
    const overlapStart = Math.max(gapStart, range.startSec);
    const overlapEnd = Math.min(gapEnd, range.endSec);
    if (overlapEnd > overlapStart) {
      exemptInGap += overlapEnd - overlapStart;
    }
  }
  return gapLength - exemptInGap;
}

/**
 * Output ranges exempt from V22-VLOG beat min/gap when narrativeProfile is present.
 */
export function resolveSlowBreathOutputRanges(
  recipe,
  output,
  abstraction,
  timelineIndex,
  wordIndexes,
) {
  void timelineIndex;

  const narrativeProfile = resolveEffectiveNarrativeProfile({ recipe, abstraction });
  if (!narrativeProfile) {
    return [];
  }

  const l2ById = new Map((abstraction?.L2 ?? []).map((entry) => [entry.segmentId, entry]));
  const ranges = [];
  const seen = new Set();

  for (const segmentProfile of narrativeProfile.segments ?? []) {
    const l2Segment = l2ById.get(segmentProfile.l2SegmentId);
    if (!isSlowBreathNarrativeSegment(segmentProfile, l2Segment)) {
      continue;
    }
    const range = resolveL2OutputRangeSec(
      segmentProfile.l2SegmentId,
      abstraction,
      recipe,
      output,
      wordIndexes,
    );
    if (range) {
      ranges.push(range);
      seen.add(segmentProfile.l2SegmentId);
    }
  }

  for (const l2Segment of abstraction?.L2 ?? []) {
    if (seen.has(l2Segment.segmentId) || l2Segment.narrativeRole !== "breath") {
      continue;
    }
    const range = resolveL2OutputRangeSec(
      l2Segment.segmentId,
      abstraction,
      recipe,
      output,
      wordIndexes,
    );
    if (range) {
      ranges.push(range);
    }
  }

  return mergeOutputRanges(ranges);
}

export function shouldPreserveSilenceForSegment(narrativeProfile, l2SegmentId) {
  if (!narrativeProfile) {
    return false;
  }
  if (narrativeProfile.silencePolicy === "preserve") {
    return true;
  }
  const segmentProfile = resolveL2SegmentProfile(narrativeProfile, l2SegmentId);
  return segmentProfile?.silencePolicy === "preserve";
}

export function resolveSilencePolicyForHint(narrativeProfile, l2SegmentId) {
  if (!narrativeProfile) {
    return null;
  }
  const segmentProfile = resolveL2SegmentProfile(narrativeProfile, l2SegmentId);
  return segmentProfile?.silencePolicy ?? narrativeProfile.silencePolicy ?? null;
}
