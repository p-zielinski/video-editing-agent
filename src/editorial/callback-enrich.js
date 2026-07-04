import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import { mapSourceTimeToOutputSec } from "./shorts-retention.js";
import { NAR_PAYOFF_TOLERANCE_SEC } from "../validators/narrative.js";

export const CALLBACK_ENRICH_MOMENT_PREFIX = "enrich_callback_";
export const MAX_CALLBACK_ENRICH_PER_MAIN = 2;
const CALLBACK_MATCH_DURATION_SEC = 1.5;
const CALLBACK_SETUP_OVERLAY_DURATION_SEC = 3;
const CALLBACK_SETUP_OVERLAY_FALLBACK_TEXT = "…";

function findMainOutput(outputs = []) {
  return outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function findMainOutputIndex(outputs = []) {
  return outputs.findIndex(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function resolveSceneMidSourceSec(sceneId, timelineIndex) {
  const scene = (timelineIndex?.scenes ?? []).find((entry) => entry.sceneId === sceneId);
  if (!scene) {
    return null;
  }
  const start = scene.startSec ?? 0;
  const end = scene.endSec ?? start + (scene.durationSec ?? 0);
  return (start + end) / 2;
}

function momentNearOutputSec(moment, targetSec, toleranceSec) {
  const anchor = moment.outputStartSec ?? moment.anchorSec ?? 0;
  return Math.abs(anchor - targetSec) <= toleranceSec;
}

function mapSceneToOutputSec(recipe, sceneId, timelineIndex, wordIndexes) {
  const clipId = sceneId.match(/^(.+)_scene\d+$/)?.[1] ?? sceneId.split("_")[0];
  const sourceMid = resolveSceneMidSourceSec(sceneId, timelineIndex);
  if (sourceMid == null) {
    return null;
  }
  return mapSourceTimeToOutputSec(recipe, clipId, sourceMid, {
    outputKind: "main",
    wordIndexes,
  });
}

function hasPayoffOverlayOnScene(mainOutput, sceneId, wordIndexes) {
  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  for (const segment of enrichedTimeline) {
    const sceneMatch = segment.videoRef?.sceneId === sceneId
      || segment.audioRef?.sceneId === sceneId;
    if (!sceneMatch) {
      continue;
    }
    if ((segment.textOverlays ?? []).some((overlay) => overlay.role === "payoff")) {
      return true;
    }
  }
  return false;
}

function hasCallbackDeliveryNearPayoff(
  recipe,
  mainOutput,
  payoffSceneId,
  timelineIndex,
  toleranceSec,
  wordIndexes,
) {
  const payoffOutputSec = mapSceneToOutputSec(
    recipe,
    payoffSceneId,
    timelineIndex,
    wordIndexes,
  );

  const matchCutMoments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId
      && moment.techniqueId === "match_cut",
  );

  if (payoffOutputSec != null) {
    if (matchCutMoments.some(
      (moment) => momentNearOutputSec(moment, payoffOutputSec, toleranceSec),
    )) {
      return true;
    }
  }

  return hasPayoffOverlayOnScene(mainOutput, payoffSceneId, wordIndexes);
}

function collectCallbackCandidates(recipe, abstraction) {
  const candidates = [];
  const seen = new Set();

  function pushCandidate(candidate) {
    const key = candidate.callbackId
      ?? `${candidate.setupSceneId ?? ""}|${candidate.payoffSceneId}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  }

  for (const loop of abstraction?.L3?.openLoops ?? []) {
    if (loop.kind !== "callback" || !loop.payoffSceneId) {
      continue;
    }
    pushCandidate({
      callbackId: loop.loopId ?? loop.kind,
      setupSceneId: loop.setupSceneId,
      payoffSceneId: loop.payoffSceneId,
      teaseText: loop.teaseText,
      source: `openLoop:${loop.loopId ?? loop.kind}`,
    });
  }

  for (const callback of recipe?.structuredCallbacks ?? []) {
    if (!callback.payoffSceneId) {
      continue;
    }
    pushCandidate({
      callbackId: callback.callbackId,
      setupSceneId: callback.setupSceneId,
      payoffSceneId: callback.payoffSceneId,
      teaseText: callback.teaseText,
      source: `structured:${callback.callbackId}`,
    });
  }

  return candidates;
}

function countExistingCallbackEnrichments(moments) {
  return moments.filter(
    (moment) => String(moment.momentId ?? "").startsWith(CALLBACK_ENRICH_MOMENT_PREFIX),
  ).length;
}

function resolveNextCallbackMomentId(moments) {
  for (let i = 1; i <= MAX_CALLBACK_ENRICH_PER_MAIN; i++) {
    const momentId = `${CALLBACK_ENRICH_MOMENT_PREFIX}${String(i).padStart(3, "0")}`;
    if (!moments.some((moment) => moment.momentId === momentId)) {
      return momentId;
    }
  }
  return null;
}

function findSegmentForScene(mainOutput, sceneId, wordIndexes) {
  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  return enrichedTimeline.find(
    (segment) => segment.videoRef?.sceneId === sceneId
      || segment.audioRef?.sceneId === sceneId,
  ) ?? null;
}

function findSegmentForOutputSec(mainOutput, outputSec, wordIndexes) {
  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  return enrichedTimeline.find(
    (seg) => outputSec >= (seg.outputStartSec ?? 0) && outputSec < (seg.outputEndSec ?? Infinity),
  ) ?? enrichedTimeline[enrichedTimeline.length - 1];
}

function addSetupEmphasisOverlay(recipe, mainOutputIndex, mainOutput, {
  momentId,
  setupSceneId,
  setupOutputSec,
  teaseText,
  wordIndexes,
}) {
  const resolvedSeg = setupSceneId
    ? findSegmentForScene(mainOutput, setupSceneId, wordIndexes)
    : findSegmentForOutputSec(mainOutput, setupOutputSec, wordIndexes);
  if (!resolvedSeg) {
    return false;
  }

  const timeline = [...mainOutput.timeline];
  const segIdx = timeline.findIndex((seg) => seg.segmentId === resolvedSeg.segmentId);
  if (segIdx < 0) {
    return false;
  }

  const segment = timeline[segIdx];
  if ((segment.textOverlays ?? []).some((overlay) => overlay.overlayId === momentId)) {
    return false;
  }

  const anchorSec = setupOutputSec ?? resolvedSeg.outputStartSec ?? 0;
  const outputStartSec = Math.round(anchorSec * 10) / 10;
  const outputEndSec = Math.round(
    (outputStartSec + CALLBACK_SETUP_OVERLAY_DURATION_SEC) * 10,
  ) / 10;

  timeline[segIdx] = {
    ...segment,
    textOverlays: [
      ...(segment.textOverlays ?? []),
      {
        overlayId: momentId,
        text: teaseText?.trim() || CALLBACK_SETUP_OVERLAY_FALLBACK_TEXT,
        style: "emphasis",
        role: "retention_beat",
        outputStartSec,
        outputEndSec,
      },
    ],
  };

  recipe.outputs[mainOutputIndex] = {
    ...mainOutput,
    timeline,
  };

  return true;
}

/**
 * Add match_cut (or setup emphasis overlay fallback) for callback open loops and
 * super-director structuredCallbacks when payoff delivery is missing near payoffSceneId.
 *
 * @param {object} recipe - EditRecipe v2 draft (mutated in place)
 * @param {{ abstraction?: object, timelineIndex?: object, wordIndexes?: object[] }} [options]
 * @returns {object[]} merged creativeMoments
 */
export function enrichRecipeCallbackMoments(recipe, {
  abstraction,
  timelineIndex,
  wordIndexes = null,
} = {}) {
  const moments = [...(recipe?.creativeMoments ?? [])];
  if (moments.some((moment) => String(moment.momentId ?? "").startsWith(CALLBACK_ENRICH_MOMENT_PREFIX))) {
    recipe.creativeMoments = moments;
    return moments;
  }

  const mainOutputIndex = findMainOutputIndex(recipe?.outputs ?? []);
  if (mainOutputIndex < 0) {
    return moments;
  }

  const mainOutput = recipe.outputs[mainOutputIndex];
  const toleranceSec = NAR_PAYOFF_TOLERANCE_SEC;
  const candidates = collectCallbackCandidates(recipe, abstraction);
  if (!candidates.length) {
    return moments;
  }

  let enrichedCount = countExistingCallbackEnrichments(moments);

  for (const candidate of candidates) {
    if (enrichedCount >= MAX_CALLBACK_ENRICH_PER_MAIN) {
      break;
    }

    if (hasCallbackDeliveryNearPayoff(
      { ...recipe, creativeMoments: moments },
      mainOutput,
      candidate.payoffSceneId,
      timelineIndex,
      toleranceSec,
      wordIndexes,
    )) {
      continue;
    }

    const momentId = resolveNextCallbackMomentId(moments);
    if (!momentId) {
      break;
    }

    const payoffOutputSec = mapSceneToOutputSec(
      recipe,
      candidate.payoffSceneId,
      timelineIndex,
      wordIndexes,
    );

    if (payoffOutputSec != null && Number.isFinite(payoffOutputSec)) {
      const outputStartSec = Math.round(payoffOutputSec * 10) / 10;
      moments.push({
        momentId,
        techniqueId: "match_cut",
        outputId: mainOutput.outputId,
        outputStartSec,
        outputEndSec: Math.round((outputStartSec + CALLBACK_MATCH_DURATION_SEC) * 10) / 10,
        params: {},
        reason: candidate.setupSceneId
          ? `Enriched callback ${candidate.callbackId}: setup ${candidate.setupSceneId} → payoff ${candidate.payoffSceneId} (${candidate.source})`
          : `Enriched callback ${candidate.callbackId} at payoff ${candidate.payoffSceneId} (${candidate.source})`,
        confidence: 0.7,
      });
      enrichedCount += 1;
      continue;
    }

    const setupOutputSec = candidate.setupSceneId
      ? mapSceneToOutputSec(recipe, candidate.setupSceneId, timelineIndex, wordIndexes)
      : null;
    if (setupOutputSec == null) {
      continue;
    }

    const addedOverlay = addSetupEmphasisOverlay(recipe, mainOutputIndex, mainOutput, {
      momentId,
      setupSceneId: candidate.setupSceneId,
      setupOutputSec,
      teaseText: candidate.teaseText,
      wordIndexes,
    });
    if (addedOverlay) {
      enrichedCount += 1;
    }
  }

  recipe.creativeMoments = moments;
  return moments;
}
