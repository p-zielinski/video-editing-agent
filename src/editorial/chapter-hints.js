import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import { resolveMainOutputDurationSec } from "./shorts-retention.js";
import {
  resolveL2OutputRangeSec,
  resolveL2SegmentProfile,
  resolveRecipeNarrativeProfile,
  resolveSegmentCaps,
} from "../lib/narrative-profile.js";

export const COLD_OPEN_SEGMENT_ID = "enrich_cold_open_01";
export const REWIND_INTRO_SEGMENT_ID = "enrich_rewind_intro_01";
export const REWIND_MOMENT_ID = "enrich_rewind_01";
export const REWIND_OVERLAY_ID = "enrich_rewind_overlay_01";

const DEFAULT_COLD_OPEN_MAX_SEC = 8;
export const COLD_OPEN_CTA_TAIL_SEC = 20;
const REWIND_INTRO_MAX_SEC = 6;

const CHAPTER_CARD_INTERVAL_SEC = 240;
const CHAPTER_CARD_MIN_DURATION_SEC = 180;
const CHAPTER_CARD_NEAR_TOLERANCE_SEC = 15;
const CHAPTER_CARD_WINDOW_SEC = 4;
const CHAPTER_SUMMARY_MAX_CHARS = 60;
const NARRATIVE_TEASE_MAX_CHARS = 100;

function truncateText(text, maxLen) {
  const s = String(text ?? "").trim();
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, maxLen - 1)}…`;
}

function findMainOutput(outputs = []) {
  return outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function findNearestL2Segment(l2Segments, targetSec) {
  let best = l2Segments[0];
  let bestDistance = Infinity;

  for (const segment of l2Segments) {
    const start = segment.startSec ?? 0;
    const end = segment.endSec ?? start;
    const mid = (start + end) / 2;
    const distance = Math.abs(mid - targetSec);
    if (distance < bestDistance) {
      best = segment;
      bestDistance = distance;
    }
  }

  return best;
}

function l2HasNarrativeRoles(l2Segments) {
  return l2Segments.some((segment) => segment.narrativeRole);
}

function shouldSkipChapterCardL2Segment(l2Segment, narrativeProfile) {
  if (l2Segment.narrativeRole === "breath") {
    return true;
  }
  const segmentProfile = resolveL2SegmentProfile(narrativeProfile, l2Segment.segmentId);
  return segmentProfile?.rhythm === "slow";
}

function buildIntervalChapterCardTargets(l2Segments, durationSec) {
  const targets = [];
  let cursor = CHAPTER_CARD_INTERVAL_SEC;

  while (cursor < durationSec - 30) {
    const segment = findNearestL2Segment(l2Segments, cursor);
    const summary = truncateText(segment?.summary, CHAPTER_SUMMARY_MAX_CHARS);
    if (summary) {
      targets.push({
        targetSec: Math.round(cursor * 10) / 10,
        text: summary,
        l2SegmentId: segment.segmentId,
      });
    }
    const nextInterval = targets.length % 2 === 0 ? 180 : 300;
    cursor += nextInterval;
  }

  return targets;
}

function buildNarrativeBoundChapterCardTargets(
  abstraction,
  durationSec,
  { recipe, narrativeProfile, mainOutput, wordIndexes } = {},
) {
  const l2Segments = abstraction?.L2 ?? [];
  const targets = [];

  for (const segment of l2Segments) {
    if (shouldSkipChapterCardL2Segment(segment, narrativeProfile)) {
      continue;
    }

    const summary = truncateText(segment?.summary, CHAPTER_SUMMARY_MAX_CHARS);
    if (!summary) {
      continue;
    }

    const range = mainOutput?.timeline?.length
      ? resolveL2OutputRangeSec(segment.segmentId, abstraction, recipe, mainOutput, wordIndexes)
      : null;
    let targetSec = range?.startSec;
    if (targetSec == null && segment.startSec != null) {
      targetSec = segment.startSec;
    }
    if (targetSec == null || targetSec >= durationSec - 30) {
      continue;
    }

    targets.push({
      targetSec: Math.round(targetSec * 10) / 10,
      text: summary,
      l2SegmentId: segment.segmentId,
    });
  }

  return targets;
}

function buildChapterCardTargets(abstraction, durationSec, options = {}) {
  const l2Segments = abstraction?.L2 ?? [];
  if (!l2Segments.length || durationSec < CHAPTER_CARD_MIN_DURATION_SEC) {
    return [];
  }

  const narrativeProfile = options.narrativeProfile
    ?? resolveRecipeNarrativeProfile(options.recipe);

  if (l2HasNarrativeRoles(l2Segments)) {
    return buildNarrativeBoundChapterCardTargets(abstraction, durationSec, {
      ...options,
      narrativeProfile,
    });
  }

  return buildIntervalChapterCardTargets(l2Segments, durationSec);
}

function collectChapterOverlays(segments) {
  const overlays = [];
  for (const seg of segments) {
    for (const overlay of seg.textOverlays ?? []) {
      if (overlay.style === "chapter_card" || overlay.role === "chapter") {
        overlays.push(overlay);
      }
    }
  }
  return overlays;
}

function hasChapterCardNear(overlays, targetSec, toleranceSec = CHAPTER_CARD_NEAR_TOLERANCE_SEC) {
  return overlays.some((overlay) => {
    const anchor = overlay.outputStartSec ?? 0;
    return Math.abs(anchor - targetSec) <= toleranceSec;
  });
}

function findSegmentForOutputSec(segments, outputSec) {
  return segments.find(
    (seg) => outputSec >= seg.outputStartSec && outputSec < seg.outputEndSec,
  ) ?? segments[segments.length - 1];
}

/**
 * Brief-only chapter_card overlay hints from L2 segment summaries.
 * With L2 narrativeRole: one card per eligible L2 start (output-mapped).
 * Otherwise: ~3–5 min interval fallback on the main output timeline.
 *
 * @param {object} abstraction
 * @param {object} [recipe]
 */
export function buildChapterCardHints(abstraction, recipe = {}) {
  const mainOutput = findMainOutput(recipe.outputs ?? []);
  if (!mainOutput) {
    return [];
  }

  const durationSec = resolveMainOutputDurationSec({
    outputs: recipe.outputs ?? [],
    batchContext: recipe.batchContext ?? {},
  });

  return buildChapterCardTargets(abstraction, durationSec, {
    recipe,
    mainOutput,
    narrativeProfile: recipe.narrativeProfile ?? recipe.batchContext?.narrativeProfile,
  }).map((target) => ({
    outputId: mainOutput.outputId,
    targetSec: target.targetSec,
    style: "chapter_card",
    l2SegmentId: target.l2SegmentId,
    suggestedText: target.text,
    suggestion:
      `Ok. ${Math.round(target.targetSec)}s — chapter_card z L2: «${target.text}»`,
  }));
}

/**
 * Add chapter_card textOverlays on the main output timeline from L2 summaries.
 * Skips targets already covered by director overlays within ±15s.
 *
 * @param {object} recipe - EditRecipe v2 draft (mutated in place)
 * @param {{ abstraction?: object }} [options]
 * @returns {object} recipe
 */
export function enrichRecipeChapterCards(recipe, { abstraction } = {}) {
  const outputs = recipe?.outputs ?? [];
  const mainOutputIndex = outputs.findIndex(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
  if (mainOutputIndex < 0) {
    return recipe;
  }

  const mainOutput = outputs[mainOutputIndex];
  const durationSec = resolveMainOutputDurationSec({
    outputs,
    batchContext: recipe.batchContext ?? {},
  });
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const targets = buildChapterCardTargets(abstraction, durationSec, {
    recipe,
    mainOutput,
    narrativeProfile,
  });
  if (!targets.length) {
    return recipe;
  }

  const enrichedTimeline = buildOutputTimeline(mainOutput);
  const existingChapterOverlays = collectChapterOverlays(enrichedTimeline);
  const timeline = [...mainOutput.timeline];

  for (const target of targets) {
    const caps = resolveSegmentCaps(narrativeProfile, target.l2SegmentId, abstraction);
    if (caps && !caps.allowChapterCards) {
      continue;
    }

    if (hasChapterCardNear(existingChapterOverlays, target.targetSec)) {
      continue;
    }

    const resolvedSeg = findSegmentForOutputSec(enrichedTimeline, target.targetSec);
    if (!resolvedSeg) {
      continue;
    }

    const segIdx = timeline.findIndex((seg) => seg.segmentId === resolvedSeg.segmentId);
    if (segIdx < 0) {
      continue;
    }

    const overlayId = `enrich_chapter_${target.l2SegmentId ?? Math.round(target.targetSec)}`;
    if (existingChapterOverlays.some((entry) => entry.overlayId === overlayId)) {
      continue;
    }

    const outputStartSec = target.targetSec;
    const outputEndSec = Math.min(
      durationSec,
      Math.round((target.targetSec + CHAPTER_CARD_WINDOW_SEC) * 10) / 10,
    );
    const overlay = {
      overlayId,
      text: target.text,
      outputStartSec,
      outputEndSec,
      style: "chapter_card",
      role: "chapter",
    };

    const segment = timeline[segIdx];
    timeline[segIdx] = {
      ...segment,
      textOverlays: [...(segment.textOverlays ?? []), overlay],
    };
    existingChapterOverlays.push(overlay);
  }

  const updatedMainOutput = {
    ...mainOutput,
    timeline,
  };
  recipe.outputs[mainOutputIndex] = updatedMainOutput;
  syncOutputChapterMarkers(updatedMainOutput, { abstraction, recipe });

  return recipe;
}

/**
 * Chapter markers from timeline chapter_card overlays (output-time positions).
 */
export function chapterMarkersFromTimeline(output) {
  const enriched = buildOutputTimeline(output);
  const markers = [];

  for (const segment of enriched) {
    for (const overlay of segment.textOverlays ?? []) {
      if (overlay.style !== "chapter_card" && overlay.role !== "chapter") {
        continue;
      }
      markers.push({
        title: overlay.text,
        startSec: overlay.outputStartSec ?? segment.outputStartSec ?? 0,
      });
    }
  }

  return markers.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Resolve chapterMarkers: recipe field → timeline overlays → L2 chapter-card targets.
 */
export function resolveChapterMarkersForOutput(output, { abstraction, recipe } = {}) {
  if ((output.chapterMarkers ?? []).length > 0) {
    return [...output.chapterMarkers].sort((a, b) => a.startSec - b.startSec);
  }

  const fromTimeline = chapterMarkersFromTimeline(output);
  if (fromTimeline.length > 0) {
    return fromTimeline;
  }

  const mainOutput = findMainOutput(recipe?.outputs ?? []);
  if (!abstraction || !recipe || mainOutput?.outputId !== output.outputId) {
    return [];
  }

  const durationSec = resolveMainOutputDurationSec({
    outputs: recipe.outputs ?? [],
    batchContext: recipe.batchContext ?? {},
  });

  return buildChapterCardTargets(abstraction, durationSec, {
    recipe,
    mainOutput: output,
  }).map((target) => ({
    title: target.text,
    startSec: target.targetSec,
  }));
}

/** Mutates output.chapterMarkers when empty. */
export function syncOutputChapterMarkers(output, options = {}) {
  output.chapterMarkers = resolveChapterMarkersForOutput(output, options);
  return output.chapterMarkers;
}

function buildStructuralLoopHint(loop) {
  const tease = loop.teaseText ? truncateText(loop.teaseText, NARRATIVE_TEASE_MAX_CHARS) : null;

  switch (loop.kind) {
    case "cold_open":
      return {
        type: "cold_open",
        loopId: loop.loopId,
        setupSceneId: loop.setupSceneId,
        payoffSceneId: loop.payoffSceneId,
        hint: tease
          ? `Cold open (${loop.loopId}): zapowiedz «${tease}» bez spoilera, potem rewind do intro`
          : `Cold open (${loop.loopId}): teaser z payoff sceny ${loop.payoffSceneId ?? "?"}, potem rewind do intro`,
      };
    case "payoff_tease":
      return {
        type: "payoff_tease",
        loopId: loop.loopId,
        setupSceneId: loop.setupSceneId,
        payoffSceneId: loop.payoffSceneId,
        hint: tease
          ? `Payoff tease (${loop.loopId}): nawiąż do «${tease}» w hooku / pierwszych 5s`
          : `Payoff tease (${loop.loopId}): nawiąż do payoff sceny ${loop.payoffSceneId ?? "?"}`,
      };
    case "callback":
      return {
        type: "callback",
        loopId: loop.loopId,
        setupSceneId: loop.setupSceneId,
        payoffSceneId: loop.payoffSceneId,
        hint: tease
          ? `Callback (${loop.loopId}): setup ${loop.setupSceneId ?? "?"} → payoff ${loop.payoffSceneId ?? "?"} («${tease}»)`
          : `Callback (${loop.loopId}): wizualny callback setup ${loop.setupSceneId ?? "?"} → payoff ${loop.payoffSceneId ?? "?"}`,
      };
    default:
      return null;
  }
}

/**
 * 1–2 bullet hints for cold open / payoff tease from L3 narrative metadata.
 * Prefers structural `L3.openLoops[]` when present; falls back to narrativeArc/sessionSummary text.
 *
 * @param {object} abstraction
 */
export function buildNarrativeOpenLoops(abstraction) {
  const l3 = abstraction?.L3;
  if (!l3) {
    return [];
  }

  const structural = l3.openLoops ?? [];
  if (structural.length > 0) {
    return structural
      .map(buildStructuralLoopHint)
      .filter(Boolean)
      .slice(0, 2);
  }

  const hints = [];

  if (l3.narrativeArc) {
    const parts = String(l3.narrativeArc)
      .split(/→|->/)
      .map((part) => part.trim())
      .filter(Boolean);
    const payoff = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    hints.push({
      type: "cold_open",
      hint:
        `Narrative arc (${l3.narrativeArc}): cold open — zapowiedz «${payoff}» bez spoilera, potem rewind do intro`,
    });
  }

  if (l3.sessionSummary) {
    const tease = truncateText(l3.sessionSummary, NARRATIVE_TEASE_MAX_CHARS);
    hints.push({
      type: "payoff_tease",
      hint:
        `Payoff tease z sessionSummary: nawiąż do «${tease}» w hooku / pierwszych 5s`,
    });
  }

  return hints.slice(0, 2);
}

function resolveClipIdFromSceneId(sceneId) {
  const match = String(sceneId).match(/^(.+)_scene\d+$/);
  return match ? match[1] : String(sceneId).split("_")[0];
}

/**
 * Lowest sortIndex A-roll intro scene for chronological rewind target.
 */
export function resolveChronologicalIntroRef(clipRegistry = [], timelineIndex = {}) {
  const sorted = [...clipRegistry].sort(
    (a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0),
  );
  const introClip = sorted.find(
    (clip) => clip.clipRole === "aroll_primary" || clip.hasSpeech,
  ) ?? sorted[0];
  if (!introClip) {
    return null;
  }

  const scene = (timelineIndex.scenes ?? [])
    .filter((entry) => entry.clipId === introClip.clipId)
    .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0))[0];
  if (!scene) {
    return null;
  }

  return { clipId: introClip.clipId, sceneId: scene.sceneId };
}

export function buildRewindOverlayText(batchContext = {}) {
  const label = batchContext.dayLabel ?? batchContext.theme ?? batchContext.notes;
  if (label && typeof label === "string" && label.length <= 40) {
    return `Wcześniej — ${label}`;
  }
  return "Wcześniej…";
}

/**
 * Brief-only hint: cold open could start on payoff tease scene before rewind.
 */
export function buildColdOpenSegmentHint(
  abstraction,
  recipe = {},
  { clipRegistry = [], timelineIndex = {} } = {},
) {
  const loops = buildNarrativeOpenLoops(abstraction);
  const coldOpenLoop = loops.find((entry) => entry.type === "cold_open");
  if (!coldOpenLoop) {
    return null;
  }

  const l2Segments = abstraction?.L2 ?? [];
  const payoffSegment = l2Segments.length > 0 ? l2Segments[l2Segments.length - 1] : null;
  const teaseSceneId = coldOpenLoop.payoffSceneId
    ?? coldOpenLoop.setupSceneId
    ?? payoffSegment?.sceneIds?.[0]
    ?? abstraction?.L1?.[abstraction.L1.length - 1]?.sceneId;

  if (!teaseSceneId) {
    return {
      type: "cold_open",
      suggestion: coldOpenLoop.hint,
      note: "Pierwszy segment mógłby zacząć od payoff tease (cold open), potem rewind do intro.",
    };
  }

  const clipId = resolveClipIdFromSceneId(teaseSceneId);
  const batchContext = recipe.batchContext ?? {};
  const rewindTargetVideoRef = resolveChronologicalIntroRef(clipRegistry, timelineIndex);

  return {
    type: "cold_open",
    suggestion: coldOpenLoop.hint,
    suggestedSceneId: teaseSceneId,
    suggestedVideoRef: { clipId, sceneId: teaseSceneId },
    rewindTargetVideoRef,
    rewindOverlayText: buildRewindOverlayText(batchContext),
    note: "Pierwszy segment mógłby zacząć od payoff tease (cold open), potem rewind do intro.",
  };
}

function sceneUsedInTimeline(timeline, sceneId) {
  return (timeline ?? []).some((segment) => segment.videoRef?.sceneId === sceneId);
}

/**
 * Pick cold-open tease in/out points within a payoff scene, avoiding CTA tail on long scenes.
 *
 * @param {number} sceneStart
 * @param {number} sceneEnd
 * @returns {{ videoInSec: number, videoOutSec: number }}
 */
export function resolveColdOpenTeaseWindow(sceneStart, sceneEnd) {
  const maxSec = DEFAULT_COLD_OPEN_MAX_SEC;
  const sceneDuration = sceneEnd - sceneStart;

  if (sceneDuration > COLD_OPEN_CTA_TAIL_SEC + maxSec) {
    const videoOutSec = sceneEnd - COLD_OPEN_CTA_TAIL_SEC;
    const videoInSec = Math.max(sceneStart, videoOutSec - maxSec);
    return { videoInSec, videoOutSec };
  }

  if (sceneDuration > maxSec * 2) {
    const mid = (sceneStart + sceneEnd) / 2;
    const videoInSec = Math.max(sceneStart, mid - maxSec / 2);
    const videoOutSec = Math.min(sceneEnd, videoInSec + maxSec);
    return { videoInSec, videoOutSec };
  }

  const duration = Math.min(maxSec, sceneDuration);
  const videoInSec = Math.max(sceneStart, sceneEnd - duration);
  return { videoInSec, videoOutSec: sceneEnd };
}

function prependColdOpenTease(mainOutput, hint, timelineIndex, { allowBrollReuse = false } = {}) {
  const firstSegment = mainOutput.timeline[0];
  if (firstSegment?.segmentId === COLD_OPEN_SEGMENT_ID
    || firstSegment?.videoRef?.sceneId === hint.suggestedSceneId) {
    return;
  }

  if (!allowBrollReuse && sceneUsedInTimeline(mainOutput.timeline, hint.suggestedSceneId)) {
    return;
  }

  const scene = (timelineIndex?.scenes ?? []).find(
    (entry) => entry.sceneId === hint.suggestedSceneId,
  );
  if (!scene) {
    return;
  }

  const sceneEnd = scene.endSec ?? scene.durationSec ?? DEFAULT_COLD_OPEN_MAX_SEC;
  const sceneStart = scene.startSec ?? 0;
  const { videoInSec, videoOutSec } = resolveColdOpenTeaseWindow(sceneStart, sceneEnd);

  mainOutput.timeline.unshift({
    segmentId: COLD_OPEN_SEGMENT_ID,
    segmentRole: "aroll",
    videoRef: { ...hint.suggestedVideoRef },
    audioRef: { ...hint.suggestedVideoRef },
    videoInSec,
    videoOutSec,
    audioInSec: videoInSec,
    audioOutSec: videoOutSec,
    audioPolicy: "from_video_ref",
    overlapSec: 0,
    cuts: [],
    textOverlays: [],
  });
}

function ensureRewindIntroSegment(mainOutput, hint, timelineIndex, { allowBrollReuse = false } = {}) {
  const target = hint.rewindTargetVideoRef;
  if (!target?.sceneId) {
    return;
  }

  if (!allowBrollReuse && sceneUsedInTimeline(mainOutput.timeline, target.sceneId)) {
    const onlyColdOpenUsesTarget = mainOutput.timeline.length === 1
      && mainOutput.timeline[0]?.segmentId === COLD_OPEN_SEGMENT_ID;
    if (!onlyColdOpenUsesTarget) {
      return;
    }
  }

  const segAt1 = mainOutput.timeline[1];
  if (segAt1?.videoRef?.sceneId === target.sceneId) {
    return;
  }

  if (mainOutput.timeline.some((segment) => segment.segmentId === REWIND_INTRO_SEGMENT_ID)) {
    return;
  }

  const scene = (timelineIndex?.scenes ?? []).find(
    (entry) => entry.sceneId === target.sceneId,
  );
  if (!scene) {
    return;
  }

  const sceneStart = scene.startSec ?? 0;
  const sceneEnd = scene.endSec ?? scene.durationSec ?? REWIND_INTRO_MAX_SEC;
  const duration = Math.min(REWIND_INTRO_MAX_SEC, sceneEnd - sceneStart);

  mainOutput.timeline.splice(1, 0, {
    segmentId: REWIND_INTRO_SEGMENT_ID,
    segmentRole: "aroll",
    videoRef: { ...target },
    audioRef: { ...target },
    videoInSec: sceneStart,
    videoOutSec: sceneStart + duration,
    audioInSec: sceneStart,
    audioOutSec: sceneStart + duration,
    audioPolicy: "from_video_ref",
    overlapSec: 0,
    cuts: [],
    textOverlays: [],
  });
}

function addColdOpenRewindMarkers(recipe, mainOutput, hint, { addSfx = true } = {}) {
  const enriched = buildOutputTimeline(mainOutput);
  const coldSeg = enriched.find((segment) => segment.segmentId === COLD_OPEN_SEGMENT_ID);
  if (!coldSeg) {
    return;
  }

  const rewindSec = coldSeg.outputEndSec ?? 0;
  recipe.creativeMoments = recipe.creativeMoments ?? [];

  if (!recipe.creativeMoments.some((moment) => moment.momentId === REWIND_MOMENT_ID)) {
    recipe.creativeMoments.push({
      momentId: REWIND_MOMENT_ID,
      techniqueId: "hard_cut_energy",
      outputId: mainOutput.outputId,
      outputStartSec: Math.max(0, rewindSec - 0.05),
      outputEndSec: roundSec(rewindSec + 0.35),
      params: {},
      reason: "Cold-open rewind — przejście do chronologii",
      confidence: 0.75,
    });
  }

  const introSegIdx = mainOutput.timeline.findIndex(
    (segment, index) => index > 0
      && segment.videoRef?.sceneId === hint.rewindTargetVideoRef?.sceneId,
  );
  if (introSegIdx >= 0 && hint.rewindOverlayText) {
    const segment = mainOutput.timeline[introSegIdx];
    const hasOverlay = (segment.textOverlays ?? []).some(
      (overlay) => overlay.overlayId === REWIND_OVERLAY_ID,
    );
    if (!hasOverlay) {
      const introEnriched = enriched.find((entry) => entry.segmentId === segment.segmentId);
      const start = introEnriched?.outputStartSec ?? rewindSec;
      mainOutput.timeline[introSegIdx] = {
        ...segment,
        textOverlays: [
          ...(segment.textOverlays ?? []),
          {
            overlayId: REWIND_OVERLAY_ID,
            text: hint.rewindOverlayText,
            outputStartSec: start,
            outputEndSec: roundSec(start + 2.5),
            style: "emphasis",
            role: "retention_beat",
          },
        ],
      };
    }
  }

  if (addSfx) {
    recipe.sfxPlan = recipe.sfxPlan ?? [];
    if (!recipe.sfxPlan.some((entry) => entry.sfxId === "whoosh")) {
      recipe.sfxPlan.push({
        sfxId: "whoosh",
        source: "library",
        label: "whoosh",
        outputStartSec: rewindSec,
        outputEndSec: roundSec(rewindSec + 0.4),
        reason: "Cold-open rewind transition",
      });
    }
  }
}

function roundSec(value) {
  return Math.round(value * 10) / 10;
}

/**
 * When cold open + rewind intro coexist, bridge tease audio into intro (J-cut).
 * @returns {boolean} whether audio bridge was applied
 */
export function applyColdOpenAudioBridge(mainOutput) {
  const timeline = mainOutput?.timeline ?? [];
  const hasColdOpen = timeline[0]?.segmentId === COLD_OPEN_SEGMENT_ID;
  const rewindSegment = timeline.find(
    (segment) => segment.segmentId === REWIND_INTRO_SEGMENT_ID,
  );
  if (!hasColdOpen || !rewindSegment) {
    return false;
  }

  rewindSegment.audioPolicy = "from_prev";
  rewindSegment.overlapSec = 0.4;
  return true;
}

/**
 * Prepends cold-open tease, rewind intro, and transition markers on main output.
 */
export function enrichRecipeColdOpenSegment(recipe, hint, timelineIndex, options = {}) {
  if (!hint?.suggestedSceneId || !hint?.suggestedVideoRef || !recipe?.outputs?.length) {
    return recipe;
  }

  const mainOutput = recipe.outputs.find((output) => output.outputKind === "main");
  if (!mainOutput?.timeline?.length) {
    return recipe;
  }

  if (mainOutput.timeline.some((segment) => segment.segmentId === COLD_OPEN_SEGMENT_ID)) {
    return recipe;
  }

  const allowBrollReuse = recipe.batchContext?.allowBrollReuse ?? false;

  prependColdOpenTease(mainOutput, hint, timelineIndex, { allowBrollReuse });
  ensureRewindIntroSegment(mainOutput, hint, timelineIndex, { allowBrollReuse });
  applyColdOpenAudioBridge(mainOutput);
  addColdOpenRewindMarkers(recipe, mainOutput, hint, options);

  return recipe;
}

/**
 * Scene ID exempt from V25-CHR-01 when used as cold-open tease before chronological intro.
 */
export function deriveTeaseSceneIdFromRecipe(recipe) {
  const main = recipe?.outputs?.find((output) => output.outputKind === "main");
  const first = main?.timeline?.[0];
  if (!first?.videoRef?.sceneId) {
    return null;
  }

  if (first.segmentId === COLD_OPEN_SEGMENT_ID) {
    return first.videoRef.sceneId;
  }

  const clipRegistry = recipe.clipRegistry ?? [];
  const firstSort = clipRegistry.find((clip) => clip.clipId === first.videoRef?.clipId)?.sortIndex;
  if (firstSort == null) {
    return null;
  }

  const nextAroll = main.timeline.slice(1).find(
    (segment) => segment.segmentRole === "aroll"
      && segment.videoRef?.clipId
      && segment.segmentId !== REWIND_INTRO_SEGMENT_ID,
  );
  if (!nextAroll?.videoRef?.clipId) {
    return null;
  }

  const nextSort = clipRegistry.find((clip) => clip.clipId === nextAroll.videoRef.clipId)?.sortIndex;
  if (nextSort == null) {
    return null;
  }

  if (firstSort > nextSort) {
    const hasRewindIntro = main.timeline.slice(1, 4).some(
      (segment) => segment.segmentId === REWIND_INTRO_SEGMENT_ID,
    );
    const hasRewindMoment = (recipe.creativeMoments ?? []).some(
      (moment) => moment.momentId === REWIND_MOMENT_ID,
    );
    if (hasRewindIntro || hasRewindMoment) {
      return first.videoRef.sceneId;
    }
  }

  return null;
}
