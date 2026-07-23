/**
 * Deterministic cleanup for hard validation errors that GPT often leaves behind.
 * Runs after other enrichers so the review loop can converge.
 */

import { loadTechniqueCatalog } from "./load-technique-catalog.js";
import {
  computeCreativityBudgetForRecipe,
  countsTowardZoomBudget,
  meetsCreativityLevel,
  SAFE_ALLOWED_TECHNIQUE_IDS,
} from "./technique-budget.js";
import {
  computeScaledMinRetentionBeats,
  countsTowardTechniqueCap,
  isRetentionBeatMoment,
  resolveEnrichBeatTechniqueId,
  VLOG_RETENTION_TECHNIQUE_ROTATION,
} from "./shorts-retention.js";
import {
  resolveL2OutputRangeSec,
  resolveRecipeNarrativeProfile,
} from "../lib/narrative-profile.js";
import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import {
  isVlogRetentionBeatMoment,
  shouldRunVlogRetentionValidation,
} from "../validators/vlog-retention.js";

const BREATH_BEAT_TECHNIQUE_IDS = new Set(["pattern_interrupt", "snap_zoom"]);
const VLOG_BEAT_TECHNIQUE_IDS = new Set([
  ...VLOG_RETENTION_TECHNIQUE_ROTATION,
  "retention_beat",
  "cut_on_beat",
  "pattern_interrupt",
  "jump_cut",
  "hard_cut_energy",
  "snap_zoom",
]);
const ROLE_KEEP_SCORE = {
  payoff: 300,
  hook: 200,
  beat: 100,
  breath: 40,
  closure: 40,
};

const ADJACENT_DUPLICATE_EPS_SEC = 0.05;
const PAYOFF_AUDIO_STACK_TOLERANCE_SEC = 0.5;
const SEGMENT_SOURCE_WINDOW_EPS_SEC = 0.15;

function segmentOutputDurationSec(segment) {
  const start = segment.outputStartSec ?? 0;
  const end = segment.outputEndSec
    ?? start + Math.max(0, (segment.videoOutSec ?? 0) - (segment.videoInSec ?? 0));
  return Math.max(0, end - start);
}

function segmentsShareIdenticalVideoWindow(left, right, eps = ADJACENT_DUPLICATE_EPS_SEC) {
  const leftClipId = left.videoRef?.clipId ?? left.sourceRef?.clipId;
  const rightClipId = right.videoRef?.clipId ?? right.sourceRef?.clipId;
  if (!leftClipId || leftClipId !== rightClipId) {
    return false;
  }

  if (
    left.videoInSec == null || left.videoOutSec == null
    || right.videoInSec == null || right.videoOutSec == null
  ) {
    return false;
  }

  const leftIn = left.videoInSec;
  const leftOut = left.videoOutSec;
  const rightIn = right.videoInSec;
  const rightOut = right.videoOutSec;

  return Math.abs(leftIn - rightIn) <= eps && Math.abs(leftOut - rightOut) <= eps;
}

function shiftSegmentOutputTimes(segment, shiftSec) {
  if (shiftSec <= 0) {
    return segment;
  }

  const shifted = { ...segment };
  if (shifted.outputStartSec != null) {
    shifted.outputStartSec -= shiftSec;
  }
  if (shifted.outputEndSec != null) {
    shifted.outputEndSec -= shiftSec;
  }

  if (shifted.subtitles) {
    shifted.subtitles = { ...shifted.subtitles };
    if (shifted.subtitles.outputStartSec != null) {
      shifted.subtitles.outputStartSec -= shiftSec;
    }
    if (shifted.subtitles.outputEndSec != null) {
      shifted.subtitles.outputEndSec -= shiftSec;
    }
  }

  if (Array.isArray(shifted.textOverlays) && shifted.textOverlays.length > 0) {
    shifted.textOverlays = shifted.textOverlays.map((overlay) => ({
      ...overlay,
      ...(overlay.outputStartSec != null
        ? { outputStartSec: overlay.outputStartSec - shiftSec }
        : {}),
      ...(overlay.outputEndSec != null
        ? { outputEndSec: overlay.outputEndSec - shiftSec }
        : {}),
    }));
  }

  return shifted;
}

function shiftOutputAnchoredEntries(entries, outputId, removal) {
  if (!Array.isArray(entries) || !removal) {
    return entries;
  }

  const { removedStartSec, removedEndSec, shiftSec } = removal;
  if (shiftSec <= 0) {
    return entries;
  }

  return entries
    .filter((entry) => {
      if (entry.outputId != null && entry.outputId !== outputId) {
        return true;
      }
      const anchor = entry.outputStartSec ?? entry.targetSec ?? 0;
      return anchor < removedStartSec || anchor >= removedEndSec;
    })
    .map((entry) => {
      if (entry.outputId != null && entry.outputId !== outputId) {
        return entry;
      }
      const anchor = entry.outputStartSec ?? entry.targetSec ?? 0;
      if (anchor < removedEndSec) {
        return entry;
      }
      const shifted = { ...entry };
      if (shifted.outputStartSec != null) {
        shifted.outputStartSec -= shiftSec;
      }
      if (shifted.outputEndSec != null) {
        shifted.outputEndSec -= shiftSec;
      }
      if (shifted.targetSec != null) {
        shifted.targetSec -= shiftSec;
      }
      return shifted;
    });
}

/**
 * Drop consecutive timeline segments that repeat the same clip video window.
 * Compacts output timing for the removed duration.
 * @param {object} recipe
 * @returns {object} recipe
 */
export function sanitizeAdjacentDuplicateSegments(recipe) {
  for (const output of recipe.outputs ?? []) {
    const timeline = output.timeline ?? [];
    const kept = [];
    const removals = [];

    for (const segment of timeline) {
      const previous = kept[kept.length - 1];
      if (previous && segmentsShareIdenticalVideoWindow(previous, segment)) {
        removals.push({
          removedStartSec: segment.outputStartSec ?? 0,
          removedEndSec: segment.outputEndSec
            ?? (segment.outputStartSec ?? 0) + segmentOutputDurationSec(segment),
          shiftSec: segmentOutputDurationSec(segment),
        });
        continue;
      }

      const shiftSec = removals.reduce((sum, removal) => sum + removal.shiftSec, 0);
      kept.push(shiftSegmentOutputTimes(segment, shiftSec));
    }

    if (removals.length > 0) {
      output.timeline = kept;
      for (const removal of removals) {
        recipe.creativeMoments = shiftOutputAnchoredEntries(
          recipe.creativeMoments,
          output.outputId,
          removal,
        );
        recipe.retentionBeatTargets = shiftOutputAnchoredEntries(
          recipe.retentionBeatTargets,
          output.outputId,
          removal,
        );
        if (recipe.soundDesign?.sfx) {
          recipe.soundDesign = {
            ...recipe.soundDesign,
            sfx: shiftOutputAnchoredEntries(recipe.soundDesign.sfx, output.outputId, removal),
          };
        }
      }
    } else {
      output.timeline = kept;
    }
  }

  return recipe;
}

/**
 * Drop cuts whose wordIds are not from the segment's audio/video clip.
 * When wordIndexes are provided, also drop cuts referencing unknown wordIds.
 * @param {object} recipe
 * @param {{ wordIndexes?: object[] }} [options]
 * @returns {object} recipe
 */
export function sanitizeInvalidWordCuts(recipe, { wordIndexes = null } = {}) {
  const wordIndexByClip = new Map();
  for (const wordIndex of wordIndexes ?? []) {
    const clipId = wordIndex.clipId ?? wordIndex.words?.[0]?.wordId?.split("_")?.[0];
    if (!clipId) {
      continue;
    }
    wordIndexByClip.set(
      clipId,
      new Set((wordIndex.words ?? []).map((word) => word.wordId)),
    );
  }

  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
      if (!clipId || !Array.isArray(segment.cuts) || segment.cuts.length === 0) {
        continue;
      }
      const prefix = `${clipId}_`;
      const knownWords = wordIndexByClip.get(clipId);
      segment.cuts = segment.cuts.filter((cut) => {
        if (
          !String(cut.startWordId ?? "").startsWith(prefix)
          || !String(cut.endWordId ?? "").startsWith(prefix)
        ) {
          return false;
        }
        if (knownWords && knownWords.size > 0) {
          return knownWords.has(cut.startWordId) && knownWords.has(cut.endWordId);
        }
        return true;
      });
    }
  }
  return recipe;
}

/**
 * Mark 2nd+ uses of the same sceneId in an output with allowBrollReuse.
 * @param {object} recipe
 * @returns {object} recipe
 */
export function allowRepeatedSceneReuse(recipe) {
  for (const output of recipe.outputs ?? []) {
    const seen = new Set();
    for (const segment of output.timeline ?? []) {
      const sceneId = segment.videoRef?.sceneId ?? segment.sourceRef?.sceneId;
      if (!sceneId) {
        continue;
      }
      if (seen.has(sceneId)) {
        segment.allowBrollReuse = true;
      } else {
        seen.add(sceneId);
      }
    }
  }
  return recipe;
}

function sceneMatchesSpeechTopics(sceneId, topicIndex, threshold) {
  return (topicIndex?.topics ?? []).some((topic) =>
    topic.matchingScenes?.some(
      (match) => match.sceneId === sceneId && (match.score ?? 1) >= threshold,
    ),
  );
}

/**
 * Reclassify broll that fails match_speech_topics as aroll (V25-BROLL-03 salvage).
 * @param {object} recipe
 * @param {object} [topicIndex]
 * @returns {object} recipe
 */
export function sanitizeUnmatchedBroll(recipe, topicIndex = null) {
  const strategy = recipe.batchContext?.brollStrategy ?? "match_speech_topics";
  if (strategy !== "match_speech_topics") {
    return recipe;
  }
  const topics = topicIndex?.topics ?? [];
  if (topics.length === 0) {
    return recipe;
  }
  const threshold = recipe.batchContext?.brollMatchThreshold ?? 0.55;
  const clipRegistryMap = new Map(
    (recipe.clipRegistry ?? []).map((clip) => [clip.clipId, clip]),
  );

  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.segmentRole !== "broll") {
        continue;
      }
      const clip = clipRegistryMap.get(segment.videoRef?.clipId);
      if (clip?.clipRole === "broll_pool") {
        continue;
      }
      const sceneId = segment.videoRef?.sceneId;
      if (!sceneId || sceneMatchesSpeechTopics(sceneId, topicIndex, threshold)) {
        continue;
      }
      segment.segmentRole = "aroll";
    }
  }
  return recipe;
}

function collectUsedVideoClipIds(recipe) {
  const used = new Set();
  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      const clipId = segment.videoRef?.clipId ?? segment.sourceRef?.clipId;
      if (clipId) {
        used.add(clipId);
      }
    }
  }
  return used;
}

/**
 * Drop whole_clip exclusions that already appear in the timeline (SCENE_EXCLUDED).
 * Softening usableAsBroll is invalid for whole_clip (EXCLUSION_USABLE_BROLL_WHOLE_CLIP).
 * @param {object} recipe
 * @returns {object} recipe
 */
export function sanitizeExcludedClipUsage(recipe) {
  if (!Array.isArray(recipe.excluded) || recipe.excluded.length === 0) {
    return recipe;
  }

  const usedClipIds = collectUsedVideoClipIds(recipe);
  recipe.excluded = recipe.excluded.filter((exclusion) => {
    if (
      exclusion.exclusionType === "whole_clip"
      && exclusion.usableAsBroll === false
      && usedClipIds.has(exclusion.clipId)
    ) {
      return false;
    }
    return true;
  });

  return recipe;
}

function estimateOutputDurationMinutes(recipe, outputId) {
  const output = recipe.outputs?.find((entry) => entry.outputId === outputId);
  if (!output) {
    return 0;
  }
  let maxSec = 0;
  for (const seg of output.timeline ?? []) {
    const end = seg.outputEndSec
      ?? (seg.outputStartSec ?? 0) + Math.max(0, (seg.videoOutSec ?? 0) - (seg.videoInSec ?? 0));
    maxSec = Math.max(maxSec, end);
  }
  return maxSec / 60;
}

function momentKeepScore(moment) {
  const roleScore = ROLE_KEEP_SCORE[moment.retentionRole] ?? 50;
  const id = String(moment.momentId ?? "");
  const idBonus = id.startsWith("enrich_payoff")
    ? 40
    : id.startsWith("enrich_")
      ? -10
      : 0;
  return roleScore + idBonus + (moment.confidence ?? 0) * 10;
}

function dropMomentsById(recipe, dropIds) {
  if (!dropIds.size || !Array.isArray(recipe.creativeMoments)) {
    return recipe;
  }
  recipe.creativeMoments = recipe.creativeMoments.filter(
    (moment) => !dropIds.has(moment.momentId),
  );
  return recipe;
}

/**
 * Enforce catalog V21-04 (min gap) and V21-05 (max per output minutes) by dropping excess moments.
 * Prefer keeping payoff/hook over beat; among equals prefer higher confidence then earlier start.
 * @param {object} recipe
 * @param {{ catalog?: object }} [options]
 * @returns {object} recipe
 */
export function sanitizeCreativeMomentDensity(recipe, { catalog = null } = {}) {
  const moments = recipe.creativeMoments ?? [];
  if (moments.length < 2) {
    return recipe;
  }

  const resolvedCatalog = catalog ?? loadTechniqueCatalog({
    pack: recipe.batchContext?.techniquePack,
  });
  const dropIds = new Set();

  const byTechniqueOutput = new Map();
  for (const moment of moments) {
    const techniqueId = moment.techniqueId;
    if (!techniqueId) {
      continue;
    }
    const outputId = moment.outputId ?? "*";
    const key = `${techniqueId}::${outputId}`;
    if (!byTechniqueOutput.has(key)) {
      byTechniqueOutput.set(key, []);
    }
    byTechniqueOutput.get(key).push(moment);
  }

  for (const [outputKey, group] of byTechniqueOutput) {
    const [techniqueId, outputId] = outputKey.split("::");
    const technique = resolvedCatalog.byId.get(techniqueId);
    const maxPerMin = technique?.constraints?.maxPerOutputMinutes;
    if (maxPerMin == null || group.length < 2) {
      continue;
    }
    const durationMin = estimateOutputDurationMinutes(
      recipe,
      outputId === "*" ? group[0]?.outputId : outputId,
    );
    if (durationMin <= 0) {
      continue;
    }
    const allowed = Math.max(1, Math.ceil(durationMin * maxPerMin));
    if (group.length <= allowed) {
      continue;
    }
    const ranked = [...group].sort((a, b) => {
      const scoreDiff = momentKeepScore(b) - momentKeepScore(a);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return (a.outputStartSec ?? 0) - (b.outputStartSec ?? 0);
    });
    for (const moment of ranked.slice(allowed)) {
      if (moment.momentId) {
        dropIds.add(moment.momentId);
      }
    }
  }

  const remaining = moments.filter((moment) => !dropIds.has(moment.momentId));
  const byTechnique = new Map();
  for (const moment of remaining) {
    if (!moment.techniqueId) {
      continue;
    }
    if (!byTechnique.has(moment.techniqueId)) {
      byTechnique.set(moment.techniqueId, []);
    }
    byTechnique.get(moment.techniqueId).push(moment);
  }

  for (const [techniqueId, group] of byTechnique) {
    const technique = resolvedCatalog.byId.get(techniqueId);
    const minGap = technique?.constraints?.minGapFromSameTechniqueSec ?? 0;
    if (minGap <= 0 || group.length < 2) {
      continue;
    }
    const sorted = [...group].sort(
      (a, b) => (a.outputStartSec ?? 0) - (b.outputStartSec ?? 0),
    );
    let prev = sorted[0];
    for (let i = 1; i < sorted.length; i += 1) {
      const current = sorted[i];
      const gap = (current.outputStartSec ?? 0) - (prev.outputEndSec ?? prev.outputStartSec ?? 0);
      if (gap >= minGap) {
        prev = current;
        continue;
      }
      // Drop the lower-priority of the conflicting pair; keep walking from the survivor.
      if (momentKeepScore(current) > momentKeepScore(prev)) {
        if (prev.momentId) {
          dropIds.add(prev.momentId);
        }
        prev = current;
      } else if (current.momentId) {
        dropIds.add(current.momentId);
      }
    }
  }

  return dropMomentsById(recipe, dropIds);
}

const ZOOM_DUTY_MIN_DURATION_SEC = 0.4;
const ZOOM_DUTY_BUDGET_EPSILON_SEC = 1e-6;
const VLOG_BEAT_DUPLICATE_TOLERANCE_SEC = 15;
const ENRICH_BEAT_DURATION_SEC = 0.6;

function momentDuration(moment) {
  return (moment.outputEndSec ?? 0) - (moment.outputStartSec ?? 0);
}

function findMainOutput(recipe) {
  const mains = (recipe.outputs ?? []).filter(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
  if (!mains.length) {
    return recipe.outputs?.[0];
  }
  return mains.find((output) => output.outputId === "main_16x9")
    ?? mains.find((output) => output.outputId?.startsWith("main_"))
    ?? mains[0];
}

function timelineDurationSec(output) {
  let maxSec = 0;
  for (const seg of output?.timeline ?? []) {
    const end = seg.outputEndSec
      ?? (seg.outputStartSec ?? 0) + Math.max(0, (seg.videoOutSec ?? 0) - (seg.videoInSec ?? 0));
    maxSec = Math.max(maxSec, end);
  }
  return maxSec;
}

function duplicateOutputKeepScore(output) {
  const id = output.outputId ?? "";
  const format = output.format;
  let score = timelineDurationSec(output) / 10_000;
  if (format === "16:9" && id === "main_16x9") {
    score += 1000;
  } else if (format === "9:16" && id === "short_9x16") {
    score += 1000;
  } else if (format === "16:9" && id.startsWith("main_")) {
    score += 500;
  } else if (format === "9:16" && id.startsWith("short_")) {
    score += 500;
  }
  return score;
}

function pickDuplicateOutputToKeep(outputs) {
  return [...outputs]
    .map((output, index) => ({ output, index }))
    .sort((left, right) => {
      const scoreDiff = duplicateOutputKeepScore(right.output) - duplicateOutputKeepScore(left.output);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return left.index - right.index;
    })[0].output;
}

function remapDroppedOutputIds(recipe, idMap) {
  const remap = (outputId) => (
    outputId != null && idMap.has(outputId) ? idMap.get(outputId) : outputId
  );

  for (const moment of recipe.creativeMoments ?? []) {
    if (moment.outputId != null) {
      moment.outputId = remap(moment.outputId);
    }
  }

  for (const target of recipe.retentionBeatTargets ?? []) {
    if (target.outputId != null) {
      target.outputId = remap(target.outputId);
    }
  }

  if (Array.isArray(recipe.audioMixPlan?.segments)) {
    for (const segment of recipe.audioMixPlan.segments) {
      if (segment.outputId != null) {
        segment.outputId = remap(segment.outputId);
      }
    }
  }

  if (Array.isArray(recipe.sceneUsageRegistry)) {
    recipe.sceneUsageRegistry = recipe.sceneUsageRegistry.map((entry) => ({
      ...entry,
      outputId: remap(entry.outputId),
    }));
  }
}

/**
 * Collapse duplicate outputs that share the same format (e.g. output_0_16x9 + main_16x9).
 * @param {object} recipe
 * @returns {object} recipe
 */
export function sanitizeDuplicateSameFormatOutputs(recipe) {
  const outputs = recipe.outputs ?? [];
  if (outputs.length < 2) {
    return recipe;
  }

  const byFormat = new Map();
  for (const output of outputs) {
    const format = output.format ?? "unknown";
    if (!byFormat.has(format)) {
      byFormat.set(format, []);
    }
    byFormat.get(format).push(output);
  }

  const idMap = new Map();
  const droppedIds = new Set();
  const keptOutputs = [];

  for (const group of byFormat.values()) {
    if (group.length === 1) {
      keptOutputs.push(group[0]);
      continue;
    }

    const kept = pickDuplicateOutputToKeep(group);
    keptOutputs.push(kept);
    for (const output of group) {
      if (output.outputId === kept.outputId) {
        continue;
      }
      if (output.outputId != null && kept.outputId != null) {
        idMap.set(output.outputId, kept.outputId);
        droppedIds.add(output.outputId);
      }
    }
  }

  if (droppedIds.size === 0) {
    return recipe;
  }

  recipe.outputs = keptOutputs;
  remapDroppedOutputIds(recipe, idMap);
  return recipe;
}

/**
 * Drop creativeMoments whose technique requires a higher creativity level than allowed.
 * @param {object} recipe
 * @param {{ catalog?: object }} [options]
 * @returns {object} recipe
 */
export function sanitizeCreativityLevelGate(recipe, { catalog = null } = {}) {
  const resolvedCatalog = catalog ?? loadTechniqueCatalog({
    pack: recipe.creativityProfile?.techniquePack ?? recipe.batchContext?.techniquePack,
  });
  const budgetEnvelope = computeCreativityBudgetForRecipe(recipe, recipe.creativityProfile);
  const defaultLevel = budgetEnvelope.default?.level
    ?? recipe.creativityProfile?.level
    ?? "balanced";

  recipe.creativeMoments = (recipe.creativeMoments ?? []).filter((moment) => {
    const technique = resolvedCatalog.byId.get(moment.techniqueId);
    if (!technique) {
      return true;
    }

    const outputBudget = moment.outputId && budgetEnvelope.byOutputId?.[moment.outputId]
      ? budgetEnvelope.byOutputId[moment.outputId]
      : budgetEnvelope.default;
    const level = outputBudget?.level ?? defaultLevel;

    if (level === "safe" && !SAFE_ALLOWED_TECHNIQUE_IDS.has(technique.id)) {
      return false;
    }

    const required = technique.constraints?.requiresCreativityLevel;
    if (required && !meetsCreativityLevel(level, required)) {
      return false;
    }

    return true;
  });

  return recipe;
}

function estimateOutputDurationSec(output) {
  if (output?.targetDurationSec) {
    return output.targetDurationSec;
  }
  let maxSec = 0;
  for (const seg of output?.timeline ?? []) {
    const end = seg.outputEndSec
      ?? (seg.outputStartSec ?? 0) + Math.max(0, (seg.videoOutSec ?? 0) - (seg.videoInSec ?? 0));
    maxSec = Math.max(maxSec, end);
  }
  return maxSec;
}

function sumZoomDuty(moments, catalog) {
  return moments
    .filter((moment) => countsTowardZoomBudget(moment.techniqueId, catalog))
    .reduce((sum, moment) => sum + momentDuration(moment), 0);
}

/**
 * Shorten or drop camera zoom moments until output zoom duty fits budget.
 * @param {object} recipe
 * @param {{ catalog?: object }} [options]
 * @returns {object} recipe
 */
export function sanitizeZoomDutyBudget(recipe, { catalog = null } = {}) {
  const resolvedCatalog = catalog ?? loadTechniqueCatalog({
    pack: recipe.batchContext?.techniquePack,
  });
  const budgetEnvelope = computeCreativityBudgetForRecipe(
    recipe,
    recipe.creativityProfile,
  );

  for (const output of recipe.outputs ?? []) {
    const outputBudget = budgetEnvelope.byOutputId[output.outputId];
    if (!outputBudget) {
      continue;
    }

    const outputMoments = (recipe.creativeMoments ?? []).filter(
      (moment) => moment.outputId === output.outputId,
    );
    const zoomMoments = outputMoments.filter(
      (moment) => countsTowardZoomBudget(moment.techniqueId, resolvedCatalog),
    );
    if (!zoomMoments.length) {
      continue;
    }

    let zoomDuty = sumZoomDuty(outputMoments, resolvedCatalog);
    const maxZoomDutySec = outputBudget.maxTotalZoomDutySec;
    if (zoomDuty <= maxZoomDutySec + ZOOM_DUTY_BUDGET_EPSILON_SEC) {
      continue;
    }

    const rankedForDrop = [...zoomMoments].sort((a, b) => {
      const scoreDiff = momentKeepScore(a) - momentKeepScore(b);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return momentDuration(b) - momentDuration(a);
    });

    let guard = 0;
    while (
      zoomDuty > maxZoomDutySec + ZOOM_DUTY_BUDGET_EPSILON_SEC
      && guard < zoomMoments.length + 8
    ) {
      guard += 1;
      const activeZoomMoments = (recipe.creativeMoments ?? []).filter(
        (moment) => moment.outputId === output.outputId
          && countsTowardZoomBudget(moment.techniqueId, resolvedCatalog),
      );
      if (!activeZoomMoments.length) {
        break;
      }

      zoomDuty = sumZoomDuty(activeZoomMoments, resolvedCatalog);
      if (zoomDuty <= maxZoomDutySec + ZOOM_DUTY_BUDGET_EPSILON_SEC) {
        break;
      }

      const longest = [...activeZoomMoments].sort(
        (a, b) => momentDuration(b) - momentDuration(a),
      )[0];
      const longestDuration = momentDuration(longest);
      const otherDuty = zoomDuty - longestDuration;
      const targetDuration = Math.max(
        ZOOM_DUTY_MIN_DURATION_SEC,
        maxZoomDutySec - otherDuty,
      );

      if (targetDuration < longestDuration) {
        longest.outputEndSec = longest.outputStartSec + targetDuration;
        zoomDuty = sumZoomDuty(activeZoomMoments, resolvedCatalog);
        continue;
      }

      const drop = rankedForDrop.shift();
      if (!drop?.momentId) {
        break;
      }
      recipe.creativeMoments = recipe.creativeMoments.filter(
        (moment) => moment.momentId !== drop.momentId,
      );
      const dropIndex = zoomMoments.findIndex((moment) => moment.momentId === drop.momentId);
      if (dropIndex >= 0) {
        zoomMoments.splice(dropIndex, 1);
      }
      zoomDuty = sumZoomDuty(
        (recipe.creativeMoments ?? []).filter((moment) => moment.outputId === output.outputId),
        resolvedCatalog,
      );
    }
  }

  return recipe;
}

/**
 * Drop decorative technique moments over per-output maxTotalTechniqueMoments.
 * Retention grammar (hook/payoff/closure/beat) is exempt — same as validator.
 * @param {object} recipe
 * @returns {object} recipe
 */
export function sanitizeTechniqueMomentCap(recipe) {
  const budgetEnvelope = computeCreativityBudgetForRecipe(
    recipe,
    recipe.creativityProfile,
  );

  const dropIds = new Set();
  for (const output of recipe.outputs ?? []) {
    const outputBudget = budgetEnvelope.byOutputId[output.outputId];
    if (!outputBudget) {
      continue;
    }

    const cappedMoments = (recipe.creativeMoments ?? []).filter(
      (moment) => moment.outputId === output.outputId && countsTowardTechniqueCap(moment),
    );
    const allowed = outputBudget.maxTotalTechniqueMoments;
    if (cappedMoments.length <= allowed) {
      continue;
    }

    const ranked = [...cappedMoments].sort((a, b) => {
      const scoreDiff = momentKeepScore(a) - momentKeepScore(b);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return (b.outputStartSec ?? 0) - (a.outputStartSec ?? 0);
    });

    for (const moment of ranked.slice(0, cappedMoments.length - allowed)) {
      if (moment.momentId) {
        dropIds.add(moment.momentId);
      }
    }
  }

  return dropMomentsById(recipe, dropIds);
}

function hasBeatNearSec(beatMoments, targetSec, toleranceSec) {
  return beatMoments.some((moment) => {
    const anchor = moment.outputStartSec ?? 0;
    return Math.abs(anchor - targetSec) <= toleranceSec;
  });
}

function isSecInOutputRanges(sec, ranges) {
  return ranges.some((range) => sec >= range.startSec && sec <= range.endSec);
}

/**
 * Output-time ranges where vlog retention beats must not be inserted
 * (slow/breath L2 segments).
 */
function buildBreathBeatRestrictedRanges(abstraction, recipe, mainOutput, wordIndexes) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (!abstraction?.L2?.length || !mainOutput) {
    return [];
  }

  const ranges = [];
  const breathSlowIds = new Set();
  for (const l2Segment of abstraction.L2) {
    if (l2Segment.narrativeRole === "breath") {
      breathSlowIds.add(l2Segment.segmentId);
    }
  }
  for (const segmentProfile of narrativeProfile?.segments ?? []) {
    if (segmentProfile.rhythm === "slow" || segmentProfile.retentionIntensity === "low") {
      breathSlowIds.add(segmentProfile.l2SegmentId);
    }
  }

  for (const l2SegmentId of breathSlowIds) {
    const range = resolveL2OutputRangeSec(
      l2SegmentId,
      abstraction,
      recipe,
      mainOutput,
      wordIndexes,
    );
    if (range) {
      ranges.push(range);
    }
  }

  return ranges;
}

/**
 * Output-time ranges where vlog retention beats must not be inserted
 * (resolution closure segment — only when L2 explicitly marks resolution).
 */
function buildResolutionBeatRestrictedRanges(abstraction, recipe, mainOutput, wordIndexes) {
  if (!abstraction?.L2?.length || !mainOutput) {
    return [];
  }

  const resolutionSegment = abstraction.L2.find(
    (entry) => entry.narrativeRole === "resolution",
  );
  if (!resolutionSegment) {
    return [];
  }

  const range = resolveL2OutputRangeSec(
    resolutionSegment.segmentId,
    abstraction,
    recipe,
    mainOutput,
    wordIndexes,
  );
  return range ? [range] : [];
}

function isForbiddenVlogBeatSec(sec, forbiddenRanges) {
  return forbiddenRanges.length > 0 && isSecInOutputRanges(sec, forbiddenRanges);
}

function appendVlogRetentionBeat(recipe, {
  mainOutput,
  targetSec,
  techniqueId,
  enrichIndex,
  reason,
}) {
  const moment = {
    momentId: `sanitize_vlog_beat_${String(enrichIndex).padStart(3, "0")}`,
    techniqueId,
    outputId: mainOutput.outputId,
    outputStartSec: targetSec,
    outputEndSec: Math.round((targetSec + ENRICH_BEAT_DURATION_SEC) * 10) / 10,
    retentionRole: "beat",
    params: {},
    reason,
    confidence: 0.6,
  };
  recipe.creativeMoments = [...(recipe.creativeMoments ?? []), moment];
  return moment;
}

function nextEnrichBeatId(existingMoments) {
  let max = 0;
  for (const moment of existingMoments) {
    const match = String(moment.momentId ?? "").match(/^sanitize_vlog_beat_(\d+)$/);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  for (const moment of existingMoments) {
    const match = String(moment.momentId ?? "").match(/^enrich_beat_sanitize_(\d+)$/);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  for (const moment of existingMoments) {
    const match = String(moment.momentId ?? "").match(/^enrich_beat_(\d+)$/);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

function maxAllowedVlogBeatGapSec(vlogProfile) {
  return (vlogProfile.retentionBeatIntervalSec ?? 45) + (vlogProfile.retentionBeatToleranceSec ?? 8);
}

function findWorstVlogCadenceGap(anchors, durationSec, hookWindowSec) {
  const points = [hookWindowSec, ...anchors, durationSec];
  let worstGap = 0;
  let insertAt = null;
  for (let i = 1; i < points.length; i += 1) {
    const gap = points[i] - points[i - 1];
    if (gap > worstGap) {
      worstGap = gap;
      insertAt = (points[i - 1] + points[i]) / 2;
    }
  }
  return { worstGap, insertAt };
}

/**
 * Strip retentionRole: beat from decorative techniques that are not vlog beat pool.
 * @param {object} recipe
 * @returns {object} recipe
 */
export function sanitizeMisclassifiedVlogBeatRoles(recipe) {
  const mainOutput = findMainOutput(recipe);
  if (!mainOutput) {
    return recipe;
  }

  for (const moment of recipe.creativeMoments ?? []) {
    if (moment.outputId !== mainOutput.outputId || moment.retentionRole !== "beat") {
      continue;
    }
    if (VLOG_BEAT_TECHNIQUE_IDS.has(moment.techniqueId)) {
      continue;
    }
    delete moment.retentionRole;
  }

  return recipe;
}

/**
 * Insert vlog retention beats at recipe.retentionBeatTargets when under min count.
 * Skips slow/breath and resolution L2 ranges so inserted beats do not trip NAR hard errors.
 * @param {object} recipe
 * @param {{ abstraction?: object, wordIndexes?: object[] }} [options]
 * @returns {object} recipe
 */
export function sanitizeMissingVlogRetentionBeats(recipe, {
  abstraction = null,
  wordIndexes = null,
} = {}) {
  if (recipe.vlogRetentionProfile?.enabled !== true) {
    return recipe;
  }
  if (!shouldRunVlogRetentionValidation(recipe)) {
    return recipe;
  }

  const mainOutput = findMainOutput(recipe);
  const vlogProfile = recipe.vlogRetentionProfile ?? {};
  if (!mainOutput || vlogProfile.enabled === false) {
    return recipe;
  }

  const durationSec = estimateOutputDurationSec(mainOutput);
  const required = computeScaledMinRetentionBeats(durationSec, vlogProfile);
  const maxRetentionBeats = computeCreativityBudgetForRecipe(recipe, recipe.creativityProfile)
    .byOutputId[mainOutput.outputId]?.maxRetentionBeatMoments ?? required;

  const countMainBeats = () => (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId && isVlogRetentionBeatMoment(moment),
  ).length;

  const beatMoments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId && isVlogRetentionBeatMoment(moment),
  );
  const targets = (recipe.retentionBeatTargets ?? [])
    .filter((entry) => entry.outputId === mainOutput.outputId)
    .map((entry) => entry.targetSec)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const breathForbiddenRanges = buildBreathBeatRestrictedRanges(
    abstraction,
    recipe,
    mainOutput,
    wordIndexes,
  );
  const resolutionForbiddenRanges = buildResolutionBeatRestrictedRanges(
    abstraction,
    recipe,
    mainOutput,
    wordIndexes,
  );
  const creativityLevel = recipe.creativityProfile?.level ?? "balanced";
  const techniqueId = resolveEnrichBeatTechniqueId("cut_on_beat", creativityLevel);
  let enrichIndex = nextEnrichBeatId(recipe.creativeMoments ?? []);
  const coverage = [...beatMoments];

  const tryInsertBeat = (targetSec, reason, {
    ignoreBreathRestrictions = false,
    allowWhenMinMet = false,
  } = {}) => {
    if (countMainBeats() >= maxRetentionBeats) {
      return false;
    }
    if (!allowWhenMinMet && countMainBeats() >= required) {
      return false;
    }
    const forbiddenRanges = ignoreBreathRestrictions
      ? resolutionForbiddenRanges
      : [...breathForbiddenRanges, ...resolutionForbiddenRanges];
    if (isForbiddenVlogBeatSec(targetSec, forbiddenRanges)) {
      return false;
    }
    if (hasBeatNearSec(coverage, targetSec, VLOG_BEAT_DUPLICATE_TOLERANCE_SEC)) {
      return false;
    }
    enrichIndex += 1;
    const moment = appendVlogRetentionBeat(recipe, {
      mainOutput,
      targetSec,
      techniqueId,
      enrichIndex,
      reason,
    });
    coverage.push(moment);
    return true;
  };

  for (const targetSec of targets) {
    tryInsertBeat(targetSec, `Sanitized vlog retention beat near target ${targetSec}s`);
  }

  if (countMainBeats() < required) {
    const interval = vlogProfile.retentionBeatIntervalSec ?? 45;
    for (let sec = interval; sec < durationSec && countMainBeats() < required; sec += interval) {
      tryInsertBeat(sec, `Sanitized evenly spaced vlog beat at ${sec}s`);
    }
  }

  if (countMainBeats() < required) {
    const interval = vlogProfile.retentionBeatIntervalSec ?? 45;
    const scanStep = Math.max(5, Math.floor(interval / 3));
    for (let sec = interval; sec < durationSec && countMainBeats() < required; sec += scanStep) {
      tryInsertBeat(sec, `Sanitized fallback vlog beat at ${sec}s`);
    }
  }

  // Last resort: when breath/slow ranges block all candidates, still satisfy min beats
  // outside resolution by spacing between existing beats or even cadence (NAR resolution only).
  if (countMainBeats() < required) {
    const anchors = coverage
      .map((moment) => moment.outputStartSec ?? 0)
      .sort((left, right) => left - right);
    const midpointCandidates = [];
    for (let i = 0; i < anchors.length - 1; i += 1) {
      midpointCandidates.push((anchors[i] + anchors[i + 1]) / 2);
    }

    const interval = vlogProfile.retentionBeatIntervalSec ?? 45;
    for (let sec = interval; sec < durationSec; sec += interval) {
      midpointCandidates.push(sec);
    }

    for (const targetSec of midpointCandidates.sort((left, right) => left - right)) {
      if (countMainBeats() >= required) {
        break;
      }
      tryInsertBeat(
        targetSec,
        `Sanitized last-resort vlog beat at ${targetSec}s (resolution-only guard)`,
        { ignoreBreathRestrictions: true },
      );
    }
  }

  const maxGap = maxAllowedVlogBeatGapSec(vlogProfile);
  const hookWindowSec = vlogProfile.hookWindowSec ?? 3;
  let cadenceGuard = 0;
  while (cadenceGuard < 12) {
    cadenceGuard += 1;
    const anchors = (recipe.creativeMoments ?? [])
      .filter((moment) => moment.outputId === mainOutput.outputId && isVlogRetentionBeatMoment(moment))
      .map((moment) => moment.outputStartSec ?? 0)
      .sort((left, right) => left - right);
    const { worstGap, insertAt } = findWorstVlogCadenceGap(anchors, durationSec, hookWindowSec);
    if (worstGap <= maxGap || insertAt == null) {
      break;
    }
    if (!tryInsertBeat(
      insertAt,
      `Sanitized cadence vlog beat at ${insertAt}s`,
      { allowWhenMinMet: true },
    )) {
      break;
    }
  }

  return recipe;
}

function isBeatMoment(moment) {
  if (moment.retentionRole === "beat") {
    return true;
  }
  if (moment.retentionRole === "hook" || moment.retentionRole === "payoff") {
    return false;
  }
  return isRetentionBeatMoment(moment) || isVlogRetentionBeatMoment(moment);
}

function isBreathBeatMoment(moment) {
  if (moment.retentionRole === "beat") {
    return true;
  }
  if (moment.retentionRole === "hook" || moment.retentionRole === "payoff"
    || moment.retentionRole === "breath" || moment.retentionRole === "closure") {
    return false;
  }
  return BREATH_BEAT_TECHNIQUE_IDS.has(moment.techniqueId);
}

function momentInOutputRange(moment, range) {
  const anchor = moment.outputStartSec ?? 0;
  return anchor >= range.startSec && anchor <= range.endSec;
}

function resolveResolutionL2Segment(abstraction) {
  const l2 = abstraction?.L2 ?? [];
  if (!l2.length) {
    return null;
  }
  return l2.find((entry) => entry.narrativeRole === "resolution") ?? null;
}

function trimBeatsInRange(moments, range, maxBeats, predicate) {
  const inRange = moments.filter(
    (moment) => predicate(moment) && momentInOutputRange(moment, range),
  );
  if (inRange.length <= maxBeats) {
    return new Set();
  }
  const ranked = [...inRange].sort((a, b) => {
    const scoreDiff = momentKeepScore(b) - momentKeepScore(a);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return (a.outputStartSec ?? 0) - (b.outputStartSec ?? 0);
  });
  const dropIds = new Set();
  for (const moment of ranked.slice(maxBeats)) {
    if (moment.momentId) {
      dropIds.add(moment.momentId);
    }
  }
  return dropIds;
}

/**
 * Strip retention beats / breath techniques that violate NAR hard-mode rules
 * (NAR-BEAT-SPAM, NAR-BREATH-BEAT, NAR-CLOSURE-SPAM) on internet_documentary.
 * @param {object} recipe
 * @param {{ abstraction?: object, wordIndexes?: object[] }} [options]
 * @returns {object} recipe
 */
export function sanitizeNarrativeBeatHardErrors(recipe, {
  abstraction = null,
  wordIndexes = null,
} = {}) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (narrativeProfile?.mode !== "internet_documentary") {
    return recipe;
  }
  if (!abstraction?.L2?.length || !Array.isArray(recipe.creativeMoments)) {
    return recipe;
  }

  const mainOutput = findMainOutput(recipe);
  if (!mainOutput) {
    return recipe;
  }

  const dropIds = new Set();
  const mainMoments = recipe.creativeMoments.filter(
    (moment) => moment.outputId === mainOutput.outputId,
  );

  const breathSlowIds = new Set();
  for (const l2Segment of abstraction.L2) {
    if (l2Segment.narrativeRole === "breath") {
      breathSlowIds.add(l2Segment.segmentId);
    }
  }
  for (const segmentProfile of narrativeProfile.segments ?? []) {
    if (segmentProfile.rhythm === "slow" || segmentProfile.retentionIntensity === "low") {
      breathSlowIds.add(segmentProfile.l2SegmentId);
    }
  }

  for (const l2SegmentId of breathSlowIds) {
    const range = resolveL2OutputRangeSec(
      l2SegmentId,
      abstraction,
      recipe,
      mainOutput,
      wordIndexes,
    );
    if (!range) {
      continue;
    }

    // NAR-BREATH-BEAT: no beat / pattern_interrupt / snap_zoom in slow/breath.
    for (const moment of mainMoments) {
      if (isBreathBeatMoment(moment) && momentInOutputRange(moment, range) && moment.momentId) {
        dropIds.add(moment.momentId);
      }
    }

    // NAR-BEAT-SPAM: after breath removals, keep at most 1 remaining beat in slow/low.
    const remaining = mainMoments.filter((moment) => !dropIds.has(moment.momentId));
    for (const id of trimBeatsInRange(remaining, range, 1, isBeatMoment)) {
      dropIds.add(id);
    }
  }

  const resolutionSegment = resolveResolutionL2Segment(abstraction);
  if (resolutionSegment) {
    const range = resolveL2OutputRangeSec(
      resolutionSegment.segmentId,
      abstraction,
      recipe,
      mainOutput,
      wordIndexes,
    );
    if (range) {
      const remaining = mainMoments.filter((moment) => !dropIds.has(moment.momentId));
      for (const id of trimBeatsInRange(remaining, range, 1, isBeatMoment)) {
        dropIds.add(id);
      }
      // Also drop enrich_beat_* entirely in resolution (maxEnrichBeats = 0).
      for (const moment of remaining) {
        if (
          moment.momentId?.startsWith("enrich_beat_")
          && momentInOutputRange(moment, range)
        ) {
          dropIds.add(moment.momentId);
        }
      }
    }
  }

  return dropMomentsById(recipe, dropIds);
}

function momentAnchorSec(moment) {
  return moment.outputStartSec ?? moment.anchorSec ?? 0;
}

/**
 * Drop silence_beat moments that stack with music_drop on the same output (±0.5s).
 * @param {object} recipe
 * @returns {object} recipe
 */
export function sanitizeStackedPayoffAudioDucks(recipe) {
  const moments = recipe.creativeMoments ?? [];
  const musicDropAnchors = moments
    .filter((moment) => moment.techniqueId === "music_drop")
    .map((moment) => ({
      outputId: moment.outputId,
      anchor: momentAnchorSec(moment),
    }));

  const dropIds = new Set();
  for (const moment of moments) {
    if (moment.techniqueId !== "silence_beat" || !moment.momentId) {
      continue;
    }
    const anchor = momentAnchorSec(moment);
    const stacked = musicDropAnchors.some(
      (entry) => entry.outputId === moment.outputId
        && Math.abs(entry.anchor - anchor) <= PAYOFF_AUDIO_STACK_TOLERANCE_SEC,
    );
    if (stacked) {
      dropIds.add(moment.momentId);
    }
  }

  return dropMomentsById(recipe, dropIds);
}

/**
 * Clear aggressive negative sourceVolumeDb — enhancement uses positive gains on WAV.
 * @param {object} recipe
 * @returns {object} recipe
 */
export function sanitizeTailSourceVolumeDb(recipe) {
  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.sourceVolumeDb != null && segment.sourceVolumeDb < -3) {
        segment.sourceVolumeDb = 0;
      }
    }
  }
  return recipe;
}

function clampSegmentSourceWindow(segment, outputDurationSec) {
  if (outputDurationSec <= 0) {
    return;
  }

  if (segment.videoInSec != null && segment.videoOutSec != null) {
    const videoDur = segment.videoOutSec - segment.videoInSec;
    if (Math.abs(videoDur - outputDurationSec) > SEGMENT_SOURCE_WINDOW_EPS_SEC) {
      segment.videoOutSec = segment.videoInSec + outputDurationSec;
    }
  }

  if (
    segment.audioPolicy !== "from_prev"
    && segment.audioPolicy !== "from_next"
    && segment.audioInSec != null
    && segment.audioOutSec != null
  ) {
    const audioDur = segment.audioOutSec - segment.audioInSec;
    if (Math.abs(audioDur - outputDurationSec) > SEGMENT_SOURCE_WINDOW_EPS_SEC) {
      segment.audioOutSec = segment.audioInSec + outputDurationSec;
    }
  }
}

/**
 * Clamp segment video/audio in-out windows to match output duration.
 * @param {object} recipe
 * @param {{ wordIndexes?: object[] }} [options]
 * @returns {object} recipe
 */
export function sanitizeSegmentSourceWindows(recipe, { wordIndexes = null } = {}) {
  for (const output of recipe.outputs ?? []) {
    const timeline = output.timeline ?? [];
    const enriched = buildOutputTimeline(output, { wordIndexes });
    for (let i = 0; i < timeline.length; i += 1) {
      const segment = timeline[i];
      const enrichedSegment = enriched[i];
      if (!segment || !enrichedSegment) {
        continue;
      }
      const outputDurationSec = (enrichedSegment.outputEndSec ?? 0)
        - (enrichedSegment.outputStartSec ?? 0);
      clampSegmentSourceWindow(segment, outputDurationSec);
    }
  }
  return recipe;
}

const CTA_SUMMARY_TEXT_PATTERNS = [/vlog/i, /nagrany/i, /materiał/i];

function looksLikeSummaryCtaText(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return false;
  }
  if (normalized.length > 30 && (normalized.includes("…") || normalized.includes("..."))) {
    return true;
  }
  return CTA_SUMMARY_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function collectPayoffOverlayRanges(recipe) {
  const ranges = [];
  for (const output of recipe.outputs ?? []) {
    const enriched = buildOutputTimeline(output);
    for (const segment of enriched) {
      for (const overlay of segment.textOverlays ?? []) {
        if (overlay.role !== "payoff") {
          continue;
        }
        ranges.push({
          outputId: output.outputId,
          startSec: overlay.outputStartSec ?? 0,
          endSec: overlay.outputEndSec ?? overlay.outputStartSec ?? 0,
        });
      }
    }
  }
  return ranges;
}

function overlayOverlapsPayoff(overlay, payoffRanges, outputId) {
  const startSec = overlay.outputStartSec ?? 0;
  const endSec = overlay.outputEndSec ?? startSec;
  return payoffRanges.some(
    (range) => range.outputId === outputId
      && startSec < range.endSec
      && range.startSec < endSec,
  );
}

/**
 * Drop enrich CTA overlays that look like session summaries or overlap payoff overlays.
 * @param {object} recipe
 * @returns {object} recipe
 */
export function sanitizeNarrativeCtaOverlays(recipe) {
  const payoffRanges = collectPayoffOverlayRanges(recipe);

  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (!Array.isArray(segment.textOverlays) || segment.textOverlays.length === 0) {
        continue;
      }
      segment.textOverlays = segment.textOverlays.filter((overlay) => {
        const isEnrichCta = overlay.overlayId?.startsWith("enrich_cta_")
          || (overlay.role === "cta" && overlay.overlayId !== "director_cta");
        if (!isEnrichCta) {
          return true;
        }
        if (looksLikeSummaryCtaText(overlay.text)) {
          return false;
        }
        if (overlayOverlapsPayoff(overlay, payoffRanges, output.outputId)) {
          return false;
        }
        return true;
      });
    }
  }

  return recipe;
}

/**
 * Apply all hard-error sanitizers in place.
 * @param {object} recipe
 * @param {{ topicIndex?: object, abstraction?: object, wordIndexes?: object[], catalog?: object }} [options]
 * @returns {object} recipe
 */
export function sanitizeRecipeHardErrors(recipe, {
  topicIndex = null,
  abstraction = null,
  wordIndexes = null,
  catalog = null,
} = {}) {
  sanitizeDuplicateSameFormatOutputs(recipe);
  sanitizeInvalidWordCuts(recipe, { wordIndexes });
  sanitizeAdjacentDuplicateSegments(recipe);
  allowRepeatedSceneReuse(recipe);
  sanitizeUnmatchedBroll(recipe, topicIndex);
  sanitizeExcludedClipUsage(recipe);
  sanitizeCreativityLevelGate(recipe, { catalog });
  sanitizeNarrativeBeatHardErrors(recipe, { abstraction, wordIndexes });
  sanitizeCreativeMomentDensity(recipe, { catalog });
  sanitizeZoomDutyBudget(recipe, { catalog });
  sanitizeTechniqueMomentCap(recipe);
  sanitizeNarrativeBeatHardErrors(recipe, { abstraction, wordIndexes });
  sanitizeStackedPayoffAudioDucks(recipe);
  sanitizeTailSourceVolumeDb(recipe);
  sanitizeSegmentSourceWindows(recipe, { wordIndexes });
  sanitizeNarrativeCtaOverlays(recipe);
  sanitizeMisclassifiedVlogBeatRoles(recipe);
  sanitizeMissingVlogRetentionBeats(recipe, { abstraction, wordIndexes });
  return recipe;
}
