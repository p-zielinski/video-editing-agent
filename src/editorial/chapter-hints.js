import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import { resolveMainOutputDurationSec } from "./shorts-retention.js";

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

function buildChapterCardTargets(abstraction, durationSec) {
  const l2Segments = abstraction?.L2 ?? [];
  if (!l2Segments.length || durationSec < CHAPTER_CARD_MIN_DURATION_SEC) {
    return [];
  }

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
 * Brief-only chapter_card overlay hints from nearest L2 segment summaries.
 * Suggests one card every ~3–5 min on the main output timeline.
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

  return buildChapterCardTargets(abstraction, durationSec).map((target) => ({
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
  const targets = buildChapterCardTargets(abstraction, durationSec);
  if (!targets.length) {
    return recipe;
  }

  const enrichedTimeline = buildOutputTimeline(mainOutput);
  const existingChapterOverlays = collectChapterOverlays(enrichedTimeline);
  const timeline = [...mainOutput.timeline];

  for (const target of targets) {
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

    const outputStartSec = target.targetSec;
    const outputEndSec = Math.min(
      durationSec,
      Math.round((target.targetSec + CHAPTER_CARD_WINDOW_SEC) * 10) / 10,
    );
    const overlay = {
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

  recipe.outputs[mainOutputIndex] = {
    ...mainOutput,
    timeline,
  };

  return recipe;
}

/**
 * 1–2 bullet hints for cold open / payoff tease from L3 narrative metadata.
 *
 * @param {object} abstraction
 */
export function buildNarrativeOpenLoops(abstraction) {
  const l3 = abstraction?.L3;
  if (!l3) {
    return [];
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
 * Brief-only hint: cold open could start on payoff tease scene before rewind.
 *
 * @param {object} abstraction
 * @param {object} [recipe]
 */
export function buildColdOpenSegmentHint(abstraction, recipe = {}) {
  const loops = buildNarrativeOpenLoops(abstraction);
  const coldOpenLoop = loops.find((entry) => entry.type === "cold_open");
  if (!coldOpenLoop) {
    return null;
  }

  const l2Segments = abstraction?.L2 ?? [];
  const payoffSegment = l2Segments.length > 0 ? l2Segments[l2Segments.length - 1] : null;
  const teaseSceneId = payoffSegment?.sceneIds?.[0]
    ?? abstraction?.L1?.[abstraction.L1.length - 1]?.sceneId;

  if (!teaseSceneId) {
    return {
      type: "cold_open",
      suggestion: coldOpenLoop.hint,
      note: "Pierwszy segment mógłby zacząć od payoff tease (cold open), potem rewind do intro.",
    };
  }

  const clipId = resolveClipIdFromSceneId(teaseSceneId);
  return {
    type: "cold_open",
    suggestion: coldOpenLoop.hint,
    suggestedSceneId: teaseSceneId,
    suggestedVideoRef: { clipId, sceneId: teaseSceneId },
    note: "Pierwszy segment mógłby zacząć od payoff tease (cold open), potem rewind do intro.",
  };
}
