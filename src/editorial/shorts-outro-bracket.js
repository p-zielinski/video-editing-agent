import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import { buildTopSceneRanks } from "./scene-rank.js";
import { shouldEnableShortsRetention } from "./shorts-retention.js";

export const SHORT_OUTRO_BRACKET_OVERLAY_ID = "enrich_short_outro_bracket";
export const SHORT_OUTRO_BRACKET_MOMENT_ID = "enrich_short_outro_swell";

const BRACKET_DURATION_SEC = 2.5;
const BRACKET_MIN_TOTAL_SEC = 8;
const BRACKET_TEXT_MAX_CHARS = 40;
const BRACKET_DEFAULT_TEXT = "I tyle.";
const WEAK_TAIL_MIN_DURATION_SEC = 18;
const WEAK_TAIL_MIN_TAIL_SEC = 6;
const WEAK_TAIL_MAX_SCENE_RANK = 0.38;
const CLOSURE_SWELL_GAIN_DB = 5;

function roundSec(value) {
  return Math.round(value * 10) / 10;
}

function truncateText(text, maxLen) {
  const s = String(text ?? "").trim();
  if (!s) {
    return "";
  }
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, maxLen - 1)}…`;
}

function findShortOutput(recipe) {
  return recipe.outputs?.find(
    (output) => output.outputKind === "short" || output.format === "9:16",
  );
}

function findShortOutputIndex(recipe) {
  return recipe.outputs?.findIndex(
    (output) => output.outputKind === "short" || output.format === "9:16",
  );
}

function collectTextOverlays(shortOutput) {
  return (shortOutput?.timeline ?? []).flatMap((seg) => seg.textOverlays ?? []);
}

function hasClosureBracket(overlays) {
  return overlays.some(
    (overlay) => overlay.overlayId === SHORT_OUTRO_BRACKET_OVERLAY_ID
      || overlay.role === "closure"
      || overlay.style === "closure_bracket",
  );
}

function hasClosureInTail(overlays, durationSec, tailSec = 12) {
  const tailStart = Math.max(0, durationSec - tailSec);
  return overlays.some(
    (overlay) => (overlay.role === "closure" || overlay.style === "closure_bracket")
      && (overlay.outputStartSec ?? 0) >= tailStart,
  );
}

function resolveBracketText(abstraction, bracketConfig = {}) {
  if (typeof bracketConfig.text === "string" && bracketConfig.text.trim()) {
    return truncateText(bracketConfig.text, BRACKET_TEXT_MAX_CHARS);
  }

  const summary = abstraction?.L3?.sessionSummary;
  if (typeof summary === "string" && summary.trim()) {
    const firstSentence = summary.split(/[.!?]/)[0]?.trim();
    if (firstSentence) {
      return truncateText(firstSentence, BRACKET_TEXT_MAX_CHARS);
    }
  }

  const l2Segments = abstraction?.L2 ?? [];
  for (let index = l2Segments.length - 1; index >= 0; index -= 1) {
    const segment = l2Segments[index];
    const candidate = segment.title ?? segment.summary;
    if (typeof candidate === "string" && candidate.trim()) {
      return truncateText(candidate, BRACKET_TEXT_MAX_CHARS);
    }
  }

  return BRACKET_DEFAULT_TEXT;
}

function trimShortTimelineForBracket(shortOutput, contentEndSec, endAtOutputSec, wordIndexes) {
  const enriched = buildOutputTimeline(shortOutput, { wordIndexes });
  if (!enriched.length) {
    return false;
  }

  const lastEnd = enriched[enriched.length - 1].outputEndSec ?? 0;
  if (endAtOutputSec >= lastEnd - 0.05) {
    return false;
  }

  let keepThroughIndex = -1;
  for (let index = 0; index < enriched.length; index += 1) {
    const seg = enriched[index];
    if ((seg.outputStartSec ?? 0) >= contentEndSec - 0.05) {
      break;
    }
    keepThroughIndex = index;
  }

  if (keepThroughIndex < 0) {
    return false;
  }

  shortOutput.timeline = shortOutput.timeline.slice(0, keepThroughIndex + 1);
  const lastSegment = shortOutput.timeline[keepThroughIndex];
  const lastEnriched = buildOutputTimeline(shortOutput, { wordIndexes }).at(-1);
  if (!lastSegment || !lastEnriched) {
    return false;
  }

  const currentEnd = lastEnriched.outputEndSec ?? 0;
  const delta = endAtOutputSec - currentEnd;
  if (Math.abs(delta) <= 0.05) {
    return true;
  }

  const audioIn = lastSegment.audioInSec ?? lastSegment.videoInSec ?? 0;
  const audioOut = lastSegment.audioOutSec ?? lastSegment.videoOutSec ?? audioIn;
  const newOut = roundSec(audioOut + delta);
  if (newOut <= audioIn + 0.5) {
    return false;
  }

  lastSegment.videoOutSec = newOut;
  lastSegment.audioOutSec = newOut;
  return true;
}

function pruneShortOutputAfterSec(recipe, outputId, endAtOutputSec) {
  recipe.creativeMoments = (recipe.creativeMoments ?? [])
    .filter((moment) => {
      if (moment.outputId !== outputId) {
        return true;
      }
      return (moment.outputStartSec ?? 0) < endAtOutputSec - 0.05;
    })
    .map((moment) => {
      if (moment.outputId !== outputId) {
        return moment;
      }
      if (moment.outputEndSec > endAtOutputSec) {
        return { ...moment, outputEndSec: endAtOutputSec };
      }
      return moment;
    });

  const shortOutput = recipe.outputs?.find((output) => output.outputId === outputId);
  if (!shortOutput) {
    return;
  }

  for (const segment of shortOutput.timeline) {
    segment.textOverlays = (segment.textOverlays ?? []).filter(
      (overlay) => (overlay.outputStartSec ?? 0) < endAtOutputSec - 0.05
        && overlay.overlayId !== SHORT_OUTRO_BRACKET_OVERLAY_ID,
    );
  }
}

function clearGeneratedBracket(recipe) {
  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      segment.textOverlays = (segment.textOverlays ?? []).filter(
        (overlay) => overlay.overlayId !== SHORT_OUTRO_BRACKET_OVERLAY_ID,
      );
    }
  }
  recipe.creativeMoments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.momentId !== SHORT_OUTRO_BRACKET_MOMENT_ID,
  );
  delete recipe.shortsOutroBracketMeta;
}

function findSegmentForOutputSec(segments, outputSec) {
  return segments.find(
    (seg) => outputSec >= seg.outputStartSec && outputSec < seg.outputEndSec,
  ) ?? segments[segments.length - 1];
}

/**
 * Detect a weak trailing segment — low scene rank with meaningful tail length.
 * @returns {{ contentEndSec: number, reason: string } | null}
 */
export function detectWeakShortTail(recipe, {
  abstraction,
  timelineIndex,
  audioIndex,
  wordIndexes = null,
} = {}) {
  const shortOutput = findShortOutput(recipe);
  if (!shortOutput?.timeline?.length) {
    return null;
  }

  const enriched = buildOutputTimeline(shortOutput, { wordIndexes });
  const durationSec = enriched.at(-1)?.outputEndSec ?? 0;
  if (durationSec < WEAK_TAIL_MIN_DURATION_SEC) {
    return null;
  }

  const sceneRanks = buildTopSceneRanks(
    { L1: abstraction?.L1, L2: abstraction?.L2, L3: abstraction?.L3 },
    timelineIndex,
    audioIndex,
    { clipRegistry: recipe.clipRegistry },
  );
  const sceneRankById = new Map(sceneRanks.map((entry) => [entry.sceneId, entry.rank]));

  const lastSeg = enriched[enriched.length - 1];
  const lastSceneId = lastSeg.videoRef?.sceneId ?? lastSeg.audioRef?.sceneId;
  const lastRank = sceneRankById.get(lastSceneId) ?? 0.5;
  const lastDuration = (lastSeg.outputEndSec ?? 0) - (lastSeg.outputStartSec ?? 0);
  const lastL2 = (abstraction?.L2 ?? []).find((segment) => (
    (segment.sceneIds ?? []).includes(lastSceneId)
  ));
  const isSetupTail = lastL2?.narrativeRole === "setup" || lastL2?.narrativeRole === "breath";

  const weakByRank = lastRank <= WEAK_TAIL_MAX_SCENE_RANK && lastDuration >= WEAK_TAIL_MIN_TAIL_SEC;
  const weakByRole = isSetupTail && lastDuration >= WEAK_TAIL_MIN_TAIL_SEC;

  if (!weakByRank && !weakByRole) {
    return null;
  }

  const earlierRanks = enriched.slice(0, -1).map(
    (seg) => sceneRankById.get(seg.videoRef?.sceneId ?? seg.audioRef?.sceneId) ?? 0,
  );
  const maxEarlierRank = earlierRanks.length ? Math.max(...earlierRanks) : 0;
  if (maxEarlierRank <= lastRank + 0.08) {
    return null;
  }

  const contentEndSec = lastSeg.outputStartSec ?? 0;
  if (contentEndSec < BRACKET_MIN_TOTAL_SEC) {
    return null;
  }

  return {
    contentEndSec: roundSec(contentEndSec),
    reason: "weak_tail_scene",
    lastRank,
  };
}

function resolveBracketPlan(recipe, {
  abstraction,
  timelineIndex,
  audioIndex,
  wordIndexes,
} = {}) {
  const bracketConfig = recipe.shortsOutroBracket;
  if (!bracketConfig) {
    return null;
  }
  if (bracketConfig.enabled === false) {
    return null;
  }

  const shortOutput = findShortOutput(recipe);
  if (!shortOutput) {
    return null;
  }

  if (!shouldEnableShortsRetention({
    outputs: recipe.outputs,
    batchContext: recipe.batchContext ?? {},
    creativityProfile: recipe.creativityProfile,
    shortsRetentionProfile: recipe.shortsRetentionProfile ?? {},
  })) {
    return null;
  }

  const enriched = buildOutputTimeline(shortOutput, { wordIndexes });
  const durationSec = enriched.at(-1)?.outputEndSec ?? 0;
  const overlays = collectTextOverlays(shortOutput);

  if (hasClosureBracket(overlays) || hasClosureInTail(overlays, durationSec)) {
    return null;
  }

  const bracketDurationSec = bracketConfig.bracketDurationSec ?? BRACKET_DURATION_SEC;
  let contentEndSec = null;
  let source = "enricher";

  if (bracketConfig.text || bracketConfig.endAtOutputSec != null) {
    source = "director";
    if (bracketConfig.endAtOutputSec != null) {
      contentEndSec = roundSec(bracketConfig.endAtOutputSec - bracketDurationSec);
    }
  }

  if (contentEndSec == null && bracketConfig.auto === true) {
    const weak = detectWeakShortTail(recipe, {
      abstraction,
      timelineIndex,
      audioIndex,
      wordIndexes,
    });
    if (weak) {
      contentEndSec = weak.contentEndSec;
    }
  }

  if (contentEndSec == null) {
    return null;
  }

  const endAtOutputSec = roundSec(contentEndSec + bracketDurationSec);
  if (endAtOutputSec < BRACKET_MIN_TOTAL_SEC || endAtOutputSec >= durationSec - 0.2) {
    return null;
  }

  return {
    contentEndSec,
    endAtOutputSec,
    bracketDurationSec,
    text: resolveBracketText(abstraction, bracketConfig),
    source,
    outputId: shortOutput.outputId,
  };
}

/**
 * Early short ending with a centered closure line and music swell when material
 * cannot support a full reel tail — director `shortsOutroBracket` or weak-tail detect.
 *
 * @param {object} recipe
 * @param {{ abstraction?: object, timelineIndex?: object, audioIndex?: object, wordIndexes?: object[] }} [options]
 */
export function enrichRecipeShortsOutroBracket(recipe, {
  abstraction,
  timelineIndex,
  audioIndex,
  wordIndexes = null,
} = {}) {
  const priorMeta = recipe.shortsOutroBracketMeta;
  if (priorMeta?.applied) {
    const shortOutput = findShortOutput(recipe);
    const durationSec = shortOutput
      ? (buildOutputTimeline(shortOutput, { wordIndexes }).at(-1)?.outputEndSec ?? 0)
      : 0;
    const overlays = collectTextOverlays(shortOutput);
    const isStillApplied = hasClosureBracket(overlays)
      && durationSec <= (priorMeta.endAtOutputSec ?? durationSec) + 0.2;
    if (isStillApplied) {
      return recipe;
    }
    clearGeneratedBracket(recipe);
  }

  const plan = resolveBracketPlan(recipe, {
    abstraction,
    timelineIndex,
    audioIndex,
    wordIndexes,
  });
  if (!plan) {
    return recipe;
  }

  const shortIdx = findShortOutputIndex(recipe);
  if (shortIdx < 0) {
    return recipe;
  }

  const shortOutput = recipe.outputs[shortIdx];
  trimShortTimelineForBracket(shortOutput, plan.contentEndSec, plan.endAtOutputSec, wordIndexes);
  pruneShortOutputAfterSec(recipe, plan.outputId, plan.endAtOutputSec);
  shortOutput.targetDurationSec = plan.endAtOutputSec;

  const enriched = buildOutputTimeline(shortOutput, { wordIndexes });
  const resolvedSeg = findSegmentForOutputSec(enriched, plan.contentEndSec);
  if (!resolvedSeg) {
    return recipe;
  }

  const segIdx = shortOutput.timeline.findIndex(
    (seg) => seg.segmentId === resolvedSeg.segmentId,
  );
  if (segIdx < 0) {
    return recipe;
  }

  const overlay = {
    overlayId: SHORT_OUTRO_BRACKET_OVERLAY_ID,
    text: plan.text,
    outputStartSec: plan.contentEndSec,
    outputEndSec: plan.endAtOutputSec,
    style: "closure_bracket",
    role: "closure",
    position: "center",
    animation: "fade",
  };

  const segment = shortOutput.timeline[segIdx];
  shortOutput.timeline[segIdx] = {
    ...segment,
    retentionRole: segment.retentionRole ?? "closure",
    textOverlays: [...(segment.textOverlays ?? []), overlay],
  };

  const moments = [...(recipe.creativeMoments ?? [])];
  if (
    recipe.audioMixPlan?.musicBed
    && !moments.some((moment) => moment.momentId === SHORT_OUTRO_BRACKET_MOMENT_ID)
  ) {
    moments.push({
      momentId: SHORT_OUTRO_BRACKET_MOMENT_ID,
      techniqueId: "music_swell",
      outputId: plan.outputId,
      outputStartSec: plan.contentEndSec,
      outputEndSec: plan.endAtOutputSec,
      params: {
        gainDb: CLOSURE_SWELL_GAIN_DB,
        durationSec: plan.bracketDurationSec,
      },
      retentionRole: "closure",
      reason: "Klamra końcowa shorta — podbicie muzyki przy zamknięciu",
    });
    recipe.creativeMoments = moments;
  }

  recipe.shortsOutroBracketMeta = {
    applied: true,
    source: plan.source,
    contentEndSec: plan.contentEndSec,
    endAtOutputSec: plan.endAtOutputSec,
    text: plan.text,
  };

  return recipe;
}
