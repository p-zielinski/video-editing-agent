import {
  countsTowardZoomBudget,
  meetsCreativityLevel,
  SAFE_ALLOWED_TECHNIQUE_IDS,
} from "../editorial/technique-budget.js";
import { isRetentionBeatMoment } from "../editorial/shorts-retention.js";
import { collectCrossfadesAtBoundaries } from "../render/ffmpeg-concat.js";
import { hasJlCutOverlap } from "../render/audio-jlcut.js";

/** J/L-cut are segment audioPolicy techniques — not creativeMoment filters. */
const SEGMENT_AUDIO_POLICY_TECHNIQUES = new Set(["j_cut", "l_cut"]);

function momentDuration(moment) {
  return (moment.outputEndSec ?? 0) - (moment.outputStartSec ?? 0);
}

function findSegmentForMoment(recipe, moment) {
  if (moment.segmentId) {
    for (const output of recipe.outputs ?? []) {
      const seg = output.timeline.find((s) => s.segmentId === moment.segmentId);
      if (seg) {
        return { segment: seg, outputId: output.outputId };
      }
    }
  }

  for (const output of recipe.outputs ?? []) {
    if (moment.outputId && output.outputId !== moment.outputId) {
      continue;
    }
    for (const seg of output.timeline) {
      const start = seg.outputStartSec ?? 0;
      const end = seg.outputEndSec ?? start + (seg.videoOutSec - seg.videoInSec);
      if (moment.outputStartSec >= start && moment.outputStartSec < end) {
        return { segment: seg, outputId: output.outputId };
      }
    }
  }

  return { segment: null, outputId: moment.outputId };
}

function getOutputIds(recipe) {
  return new Set((recipe.outputs ?? []).map((o) => o.outputId));
}

function estimateOutputDurationMinutes(recipe, outputId) {
  const output = recipe.outputs?.find((o) => o.outputId === outputId);
  if (!output) {
    return 0;
  }
  let maxSec = 0;
  for (const seg of output.timeline) {
    const end = seg.outputEndSec
      ?? (seg.outputStartSec ?? 0) + (seg.videoOutSec - seg.videoInSec);
    maxSec = Math.max(maxSec, end);
  }
  return maxSec / 60;
}

function validateParams(moment, technique) {
  const issues = [];
  const params = moment.params ?? {};

  for (const [key, def] of Object.entries(technique.params ?? {})) {
    if (params[key] == null) {
      continue;
    }
    const value = params[key];
    if (def.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push({
          severity: "error",
          code: "V21-02",
          message: `Moment ${moment.momentId}: param ${key} musi być liczbą`,
          momentId: moment.momentId,
        });
        continue;
      }
      if (def.min != null && value < def.min) {
        issues.push({
          severity: "error",
          code: "V21-02",
          message: `Moment ${moment.momentId}: ${key}=${value} < min ${def.min}`,
          momentId: moment.momentId,
        });
      }
      if (def.max != null && value > def.max) {
        issues.push({
          severity: "error",
          code: "V21-02",
          message: `Moment ${moment.momentId}: ${key}=${value} > max ${def.max}`,
          momentId: moment.momentId,
        });
      }
    }
    if (def.type === "enum" && def.values && !def.values.includes(value)) {
      issues.push({
        severity: "error",
        code: "V21-02",
        message: `Moment ${moment.momentId}: ${key}='${value}' poza dozwolonymi wartościami`,
        momentId: moment.momentId,
      });
    }
  }

  return issues;
}

function validateCreativityLevelGate(moment, technique, budget) {
  const issues = [];
  const level = budget?.level ?? "balanced";

  if (level === "safe" && !SAFE_ALLOWED_TECHNIQUE_IDS.has(technique.id)) {
    issues.push({
      severity: "error",
      code: "V21-03",
      message: `Moment ${moment.momentId}: ${technique.id} niedozwolone przy poziomie safe`,
      momentId: moment.momentId,
    });
  }

  const required = technique.constraints?.requiresCreativityLevel;
  if (required && !meetsCreativityLevel(level, required)) {
    issues.push({
      severity: "error",
      code: "V21-03",
      message: `Moment ${moment.momentId}: ${technique.id} wymaga poziomu ≥ ${required} (aktualny: ${level})`,
      momentId: moment.momentId,
    });
  }

  return issues;
}

function validateStructural(moment, recipe) {
  const issues = [];
  const outputIds = getOutputIds(recipe);

  if (moment.outputEndSec <= moment.outputStartSec) {
    issues.push({
      severity: "error",
      code: "V21-STRUCT",
      message: `Moment ${moment.momentId}: outputEndSec musi być > outputStartSec`,
      momentId: moment.momentId,
    });
  }

  if (moment.outputId && !outputIds.has(moment.outputId)) {
    issues.push({
      severity: "error",
      code: "V21-STRUCT",
      message: `Moment ${moment.momentId}: nieznany outputId ${moment.outputId}`,
      momentId: moment.momentId,
    });
  }

  if (moment.segmentId) {
    const { segment } = findSegmentForMoment(recipe, moment);
    if (!segment) {
      issues.push({
        severity: "error",
        code: "V21-STRUCT",
        message: `Moment ${moment.momentId}: nieznany segmentId ${moment.segmentId}`,
        momentId: moment.momentId,
      });
    } else {
      const segStart = segment.outputStartSec ?? 0;
      const segEnd = segment.outputEndSec
        ?? segStart + (segment.videoOutSec - segment.videoInSec);
      if (moment.outputStartSec < segStart || moment.outputEndSec > segEnd) {
        issues.push({
          severity: "error",
          code: "V21-STRUCT",
          message: `Moment ${moment.momentId}: poza zakresem segmentu ${moment.segmentId}`,
          momentId: moment.momentId,
        });
      }
    }
  }

  return issues;
}

const SPATIAL_BBOX_TOLERANCE = 0.15;

function bboxMaxDelta(a, b) {
  return Math.max(...a.map((value, index) => Math.abs(value - b[index])));
}

function validateSpatialRef(moment, spatialIndex) {
  const spatialRef = moment.spatialRef;
  if (!spatialRef || !spatialIndex) {
    return [];
  }

  const scenes = spatialIndex.scenes ?? [];
  const sceneEntry = scenes.find((entry) => entry.sceneId === spatialRef.sceneId);
  if (!sceneEntry) {
    return [{
      severity: "error",
      code: "V21-10",
      message: `Moment ${moment.momentId}: spatialRef.sceneId '${spatialRef.sceneId}' nie istnieje w spatial index`,
      momentId: moment.momentId,
      sceneId: spatialRef.sceneId,
    }];
  }

  const issues = [];
  const confidence = moment.confidence ?? 1;

  if (spatialRef.clipId) {
    const expectedClipId = sceneEntry.clipId ?? null;
    const prefixMatch = spatialRef.sceneId.startsWith(`${spatialRef.clipId}_`);
    const entryMatch = expectedClipId != null && spatialRef.clipId === expectedClipId;
    if (!prefixMatch && !entryMatch) {
      issues.push({
        severity: "error",
        code: "V21-10",
        message: `Moment ${moment.momentId}: spatialRef.clipId '${spatialRef.clipId}' nie pasuje do sceneId '${spatialRef.sceneId}'`,
        momentId: moment.momentId,
        sceneId: spatialRef.sceneId,
      });
    }
  }

  if (!spatialRef.bbox) {
    return issues;
  }

  const anchors = sceneEntry.anchors ?? [];
  if (anchors.length === 0) {
    issues.push({
      severity: "error",
      code: "V21-10",
      message: `Moment ${moment.momentId}: spatialRef.bbox podany, ale scena ${spatialRef.sceneId} nie ma anchorów w spatial index`,
      momentId: moment.momentId,
      sceneId: spatialRef.sceneId,
    });
    return issues;
  }

  const primary = anchors[0];
  const delta = bboxMaxDelta(spatialRef.bbox, primary.bbox);
  if (delta > SPATIAL_BBOX_TOLERANCE) {
    issues.push({
      severity: confidence > 0.6 ? "error" : "warning",
      code: "V21-10",
      message: `Moment ${moment.momentId}: spatialRef.bbox odbiega od primary anchor (delta ${delta.toFixed(2)} > ${SPATIAL_BBOX_TOLERANCE})`,
      momentId: moment.momentId,
      sceneId: spatialRef.sceneId,
    });
  }

  if (spatialRef.anchorType && spatialRef.anchorType !== primary.type) {
    issues.push({
      severity: confidence > 0.6 ? "error" : "warning",
      code: "V21-10",
      message: `Moment ${moment.momentId}: spatialRef.anchorType '${spatialRef.anchorType}' ≠ primary '${primary.type}'`,
      momentId: moment.momentId,
      sceneId: spatialRef.sceneId,
    });
  }

  return issues;
}

function validateAnchorWordId(moment, wordIds) {
  if (!moment.anchorWordId) {
    return [];
  }

  if (wordIds && wordIds.size > 0) {
    if (!wordIds.has(moment.anchorWordId)) {
      return [{
        severity: "error",
        code: "V21-09",
        message: `Moment ${moment.momentId}: anchorWordId '${moment.anchorWordId}' nie istnieje w word index`,
        momentId: moment.momentId,
      }];
    }
    return [];
  }

  if (!/^[A-Za-z0-9_-]+_w\d{4,5}$/.test(moment.anchorWordId)) {
    return [{
      severity: "error",
      code: "V21-09",
      message: `Moment ${moment.momentId}: anchorWordId '${moment.anchorWordId}' ma nieprawidłowy format (oczekiwano clipId_wNNNN)`,
      momentId: moment.momentId,
    }];
  }

  return [];
}

function findNearestBeat(beats, timeSec) {
  if (!beats?.length || !Number.isFinite(timeSec)) {
    return null;
  }
  let nearest = beats[0];
  let minDist = Math.abs(beats[0].timeSec - timeSec);
  for (const beat of beats) {
    const dist = Math.abs(beat.timeSec - timeSec);
    if (dist < minDist) {
      minDist = dist;
      nearest = beat;
    }
  }
  return { beat: nearest, distanceSec: minDist };
}

function resolveClipIdForMoment(recipe, moment) {
  const { segment } = findSegmentForMoment(recipe, moment);
  return segment?.audioRef?.clipId ?? segment?.videoRef?.clipId ?? null;
}

function resolveSourceTimeSec(recipe, moment) {
  const { segment } = findSegmentForMoment(recipe, moment);
  if (!segment) {
    return null;
  }
  const segStart = segment.outputStartSec ?? 0;
  return (moment.outputStartSec - segStart) + (segment.audioInSec ?? segment.videoInSec ?? 0);
}

function hasNearbySilenceAnchor(sourceTimeSec, analysis, toleranceSec) {
  if (!Number.isFinite(sourceTimeSec)) {
    return false;
  }

  for (const gap of analysis?.silenceGaps ?? []) {
    if (
      sourceTimeSec >= (gap.startSec - toleranceSec)
      && sourceTimeSec <= (gap.endSec + toleranceSec)
    ) {
      return true;
    }
  }

  for (const cut of analysis?.cutSuggestions ?? []) {
    if (Math.abs(cut.timeSec - sourceTimeSec) <= toleranceSec) {
      return true;
    }
  }

  return false;
}

function validateMusicSwell(moment, recipe) {
  if (moment.techniqueId !== "music_swell") {
    return [];
  }

  if (recipe.audioMixPlan?.musicBed) {
    return [];
  }

  return [{
    severity: "warning",
    code: "V21-12",
    message: `Moment ${moment.momentId}: music_swell wymaga audioMixPlan.musicBed`,
    momentId: moment.momentId,
  }];
}

function validateSilenceBeat(moment, recipe, audioIndexByClip) {
  if (moment.techniqueId !== "silence_beat") {
    return [];
  }

  const clipId = resolveClipIdForMoment(recipe, moment);
  if (!clipId || !audioIndexByClip?.has(clipId)) {
    return [];
  }

  const analysis = audioIndexByClip.get(clipId);
  const silenceGaps = analysis?.silenceGaps ?? [];
  const cutSuggestions = analysis?.cutSuggestions ?? [];
  if (silenceGaps.length === 0 && cutSuggestions.length === 0) {
    return [];
  }

  const sourceTimeSec = resolveSourceTimeSec(recipe, moment);
  const toleranceSec = moment.params?.durationSec ?? 0.8;
  if (hasNearbySilenceAnchor(sourceTimeSec, analysis, toleranceSec)) {
    return [];
  }

  return [{
    severity: "warning",
    code: "V21-13",
    message: `Moment ${moment.momentId}: silence_beat ${sourceTimeSec?.toFixed(2) ?? "?"}s bez bliskiego silenceGap lub cutSuggestion (tolerancja ${toleranceSec}s)`,
    momentId: moment.momentId,
  }];
}

function validateBeatSync(moment, recipe, audioIndexByClip, toleranceSec = 0.5) {
  if (moment.techniqueId !== "cut_on_beat") {
    return [];
  }

  const clipId = resolveClipIdForMoment(recipe, moment);
  if (!clipId || !audioIndexByClip?.has(clipId)) {
    return [];
  }

  const analysis = audioIndexByClip.get(clipId);
  const rawBeats = analysis?.beats ?? analysis?.beatTimes ?? [];
  const beats = rawBeats.map((beat) =>
    typeof beat === "number" ? { timeSec: beat } : beat,
  );
  if (beats.length === 0) {
    return [];
  }

  const sourceTimeSec = resolveSourceTimeSec(recipe, moment);
  const snapTolerance = moment.params?.snapToleranceSec ?? 0.5;
  const nearest = findNearestBeat(beats, sourceTimeSec);
  if (!nearest || nearest.distanceSec <= snapTolerance) {
    return [];
  }

  return [{
    severity: "warning",
    code: "V21-11",
    message: `Moment ${moment.momentId}: cut_on_beat ${sourceTimeSec.toFixed(2)}s od beat o ${nearest.distanceSec.toFixed(2)}s (tolerancja ${snapTolerance}s)`,
    momentId: moment.momentId,
  }];
}

function validatePartialCrossfadePattern(recipe, creativeMoments) {
  const issues = [];

  for (const output of recipe.outputs ?? []) {
    const segments = output.timeline ?? [];
    if (segments.length < 3 || hasJlCutOverlap(segments)) {
      continue;
    }

    const outputMoments = (creativeMoments ?? []).filter(
      (m) => !m.outputId || m.outputId === output.outputId,
    );
    const boundaries = collectCrossfadesAtBoundaries(outputMoments, segments);
    const crossfadeCount = boundaries.filter(Boolean).length;
    if (crossfadeCount === 0) {
      continue;
    }

    const numBoundaries = segments.length - 1;
    const eligible = crossfadeCount === 1 || crossfadeCount === numBoundaries;
    if (!eligible) {
      issues.push({
        severity: "warning",
        code: "V21-15",
        message: `Output ${output.outputId}: crossfade na ${crossfadeCount}/${numBoundaries} joinach — renderer wymaga crossfade na każdym joinie lub dokładnie jednym; usuń częściowy wzór albo uzupełnij wszystkie joiny`,
        outputId: output.outputId,
      });
    }
  }

  return issues;
}

function resolveBudgetEnvelope(budget) {
  if (budget?.byOutputId) {
    return { byOutputId: budget.byOutputId, default: budget.default ?? budget };
  }
  return { byOutputId: null, default: budget };
}

function momentsForOutput(moments, outputId, recipe) {
  return moments.filter((moment) => {
    if (moment.outputId) {
      return moment.outputId === outputId;
    }
    const mainOutput = (recipe.outputs ?? []).find((output) => output.outputKind === "main");
    return mainOutput?.outputId === outputId;
  });
}

function validateOutputBudgetLimits(moments, outputBudget, catalog, outputLabel) {
  const issues = [];
  if (!outputBudget) {
    return issues;
  }

  const isMain = outputBudget.outputKind === "main";
  const beatMoments = isMain ? moments.filter(isRetentionBeatMoment) : [];
  const nonBeatMoments = isMain
    ? moments.filter((moment) => !isRetentionBeatMoment(moment))
    : moments;

  const zoomMoments = moments.filter((moment) => countsTowardZoomBudget(moment.techniqueId, catalog));
  if (zoomMoments.length > outputBudget.maxZoomMoments) {
    issues.push({
      severity: "error",
      code: "V21-05",
      message: `Output ${outputLabel}: camera moments ${zoomMoments.length} > maxZoomMoments=${outputBudget.maxZoomMoments}`,
    });
  }

  let zoomDuty = 0;
  const sortedZoom = [...zoomMoments].sort((a, b) => a.outputStartSec - b.outputStartSec);
  for (let i = 0; i < sortedZoom.length; i++) {
    zoomDuty += momentDuration(sortedZoom[i]);
    if (i > 0) {
      const gap = sortedZoom[i].outputStartSec - sortedZoom[i - 1].outputEndSec;
      if (gap < outputBudget.minZoomGapSec) {
        issues.push({
          severity: "error",
          code: "V21-04",
          message: `Output ${outputLabel}: camera gap ${gap.toFixed(1)}s < minZoomGapSec=${outputBudget.minZoomGapSec} (end→start)`,
          momentId: sortedZoom[i].momentId,
        });
      }
    }
  }
  if (zoomDuty > outputBudget.maxTotalZoomDutySec) {
    issues.push({
      severity: "error",
      code: "V21-05",
      message: `Output ${outputLabel}: camera duty ${zoomDuty.toFixed(1)}s > maxTotalZoomDutySec=${outputBudget.maxTotalZoomDutySec.toFixed(1)}`,
    });
  }

  if (nonBeatMoments.length > outputBudget.maxTotalTechniqueMoments) {
    issues.push({
      severity: "error",
      code: "V21-05",
      message: `Output ${outputLabel}: ${nonBeatMoments.length} momentów (bez beat pool) > maxTotalTechniqueMoments=${outputBudget.maxTotalTechniqueMoments}`,
    });
  }

  if (isMain && outputBudget.maxRetentionBeatMoments != null) {
    if (beatMoments.length > outputBudget.maxRetentionBeatMoments) {
      issues.push({
        severity: "error",
        code: "V21-05",
        message: `Output ${outputLabel}: ${beatMoments.length} beatów > maxRetentionBeatMoments=${outputBudget.maxRetentionBeatMoments}`,
      });
    }
  }

  return issues;
}

function validateGlobalBudgetLimits(moments, budget, catalog) {
  const issues = [];
  if (!budget) {
    return issues;
  }

  const zoomMoments = moments.filter((moment) => countsTowardZoomBudget(moment.techniqueId, catalog));
  if (zoomMoments.length > budget.maxZoomMoments) {
    issues.push({
      severity: "error",
      code: "V21-05",
      message: `Camera moments: ${zoomMoments.length} > budżet maxZoomMoments=${budget.maxZoomMoments}`,
    });
  }

  let zoomDuty = 0;
  const sortedZoom = [...zoomMoments].sort((a, b) => a.outputStartSec - b.outputStartSec);
  for (let i = 0; i < sortedZoom.length; i++) {
    zoomDuty += momentDuration(sortedZoom[i]);
    if (i > 0) {
      const gap = sortedZoom[i].outputStartSec - sortedZoom[i - 1].outputEndSec;
      if (gap < budget.minZoomGapSec) {
        issues.push({
          severity: "error",
          code: "V21-04",
          message: `Camera gap ${gap.toFixed(1)}s < minZoomGapSec=${budget.minZoomGapSec} (end→start)`,
          momentId: sortedZoom[i].momentId,
        });
      }
    }
  }
  if (zoomDuty > budget.maxTotalZoomDutySec) {
    issues.push({
      severity: "error",
      code: "V21-05",
      message: `Camera duty ${zoomDuty.toFixed(1)}s > maxTotalZoomDutySec=${budget.maxTotalZoomDutySec.toFixed(1)}`,
    });
  }

  if (moments.length > budget.maxTotalTechniqueMoments) {
    issues.push({
      severity: "error",
      code: "V21-05",
      message: `Łącznie ${moments.length} momentów > maxTotalTechniqueMoments=${budget.maxTotalTechniqueMoments}`,
    });
  }

  return issues;
}

/**
 * Walidacja creativeMoments vs katalog i budżet (V21-01 … V21-15).
 */
export function validateCreativeMoments(recipe, catalog, budget, { wordIds, spatialIndex, audioIndexByClip } = {}) {
  const moments = recipe.creativeMoments ?? [];
  if (!moments.length) {
    return [];
  }

  const issues = [];
  const profile = recipe.creativityProfile ?? {};
  const { default: levelBudget } = resolveBudgetEnvelope(budget);
  const byTechnique = new Map();
  const byTechniqueOutput = new Map();
  const seenMomentIds = new Set();

  for (const moment of moments) {
    if (moment.momentId) {
      if (seenMomentIds.has(moment.momentId)) {
        issues.push({
          severity: "error",
          code: "V21-STRUCT",
          message: `Zduplikowany momentId: ${moment.momentId}`,
          momentId: moment.momentId,
        });
      }
      seenMomentIds.add(moment.momentId);
    }

    // V21-08
    if (!moment.reason || String(moment.reason).trim() === "") {
      issues.push({
        severity: "error",
        code: "V21-08",
        message: `Moment ${moment.momentId ?? "?"}: brak reason`,
        momentId: moment.momentId,
      });
    }

    issues.push(...validateStructural(moment, recipe));
    issues.push(...validateAnchorWordId(moment, wordIds));
    issues.push(...validateSpatialRef(moment, spatialIndex));
    issues.push(...validateBeatSync(moment, recipe, audioIndexByClip));
    issues.push(...validateMusicSwell(moment, recipe));
    issues.push(...validateSilenceBeat(moment, recipe, audioIndexByClip));

    // V21-01
    const technique = catalog.byId.get(moment.techniqueId);
    if (!technique) {
      issues.push({
        severity: "error",
        code: "V21-01",
        message: `Nieznana technika: ${moment.techniqueId}`,
        momentId: moment.momentId,
      });
      continue;
    }

    issues.push(...validateParams(moment, technique));
    issues.push(...validateCreativityLevelGate(moment, technique, levelBudget));

    // V21-14 j_cut / l_cut belong on segment audioPolicy, not creativeMoments
    if (SEGMENT_AUDIO_POLICY_TECHNIQUES.has(moment.techniqueId)) {
      issues.push({
        severity: "error",
        code: "V21-14",
        message: `Moment ${moment.momentId}: ${moment.techniqueId} nie jako creativeMoment — użyj audioPolicy from_prev/from_next + overlapSec na segmencie`,
        momentId: moment.momentId,
      });
      continue;
    }

    // V21-03 cut_mid_sentence
    if (
      technique.constraints?.allowMidSentenceCuts
      && !profile.allowMidSentenceCuts
      && !levelBudget?.allowMidSentenceCuts
    ) {
      issues.push({
        severity: "error",
        code: "V21-03",
        message: `Moment ${moment.momentId}: ${technique.id} wymaga allowMidSentenceCuts`,
        momentId: moment.momentId,
      });
    }

    const { segment } = findSegmentForMoment(recipe, moment);

    // V21-06
    const forbiddenRoles = technique.constraints?.forbiddenOnSegmentRole ?? [];
    if (segment && forbiddenRoles.includes(segment.segmentRole)) {
      issues.push({
        severity: "error",
        code: "V21-06",
        message: `Moment ${moment.momentId}: ${technique.id} zabronione na segmentRole=${segment.segmentRole}`,
        momentId: moment.momentId,
        sceneId: segment.videoRef?.sceneId,
      });
    }

    // V21-07
    if (technique.constraints?.requiresSpatialAnchor) {
      const hasSpatial = Boolean(moment.spatialRef);
      const hasAnchorWord = Boolean(moment.anchorWordId);
      const arollAnchor = segment?.segmentRole === "aroll" && hasAnchorWord;
      if (!hasSpatial && !arollAnchor) {
        issues.push({
          severity: "warning",
          code: "V21-07",
          message: `Moment ${moment.momentId}: ${technique.id} wymaga spatialRef lub anchorWordId na A-roll`,
          momentId: moment.momentId,
        });
        if ((moment.confidence ?? 1) > 0.6) {
          issues.push({
            severity: "warning",
            code: "NEEDS_SPATIAL_REVIEW",
            message: `Moment ${moment.momentId}: confidence > 0.6 bez spatialRef — obniż confidence`,
            momentId: moment.momentId,
          });
        }
      }
    }

    if (!byTechnique.has(moment.techniqueId)) {
      byTechnique.set(moment.techniqueId, []);
    }
    byTechnique.get(moment.techniqueId).push(moment);

    const outputKey = `${moment.techniqueId}::${moment.outputId ?? "*"}`;
    if (!byTechniqueOutput.has(outputKey)) {
      byTechniqueOutput.set(outputKey, []);
    }
    byTechniqueOutput.get(outputKey).push(moment);
  }

  // V21-04 min gap per technique (end → start)
  for (const [techniqueId, group] of byTechnique) {
    const technique = catalog.byId.get(techniqueId);
    const minGap = technique?.constraints?.minGapFromSameTechniqueSec ?? 0;
    if (minGap <= 0 || group.length < 2) {
      continue;
    }
    const sorted = [...group].sort((a, b) => a.outputStartSec - b.outputStartSec);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].outputStartSec - sorted[i - 1].outputEndSec;
      if (gap < minGap) {
        issues.push({
          severity: "error",
          code: "V21-04",
          message: `Technika ${techniqueId}: gap ${gap.toFixed(1)}s < min ${minGap}s (end→start) między momentami`,
          momentId: sorted[i].momentId,
        });
      }
    }
  }

  // V21-05 maxPerOutputMinutes per outputId
  for (const [outputKey, group] of byTechniqueOutput) {
    const [techniqueId, outputId] = outputKey.split("::");
    const technique = catalog.byId.get(techniqueId);
    const maxPerMin = technique?.constraints?.maxPerOutputMinutes;
    if (maxPerMin == null) {
      continue;
    }
    const durationMin = outputId === "*"
      ? estimateOutputDurationMinutes(recipe, group[0]?.outputId)
      : estimateOutputDurationMinutes(recipe, outputId);
    if (durationMin <= 0) {
      continue;
    }
    const allowed = Math.max(1, Math.ceil(durationMin * maxPerMin));
    if (group.length > allowed) {
      issues.push({
        severity: "error",
        code: "V21-05",
        message: `Technika ${techniqueId} na ${outputId}: ${group.length} momentów > max ${allowed} dla ${durationMin.toFixed(1)} min`,
      });
    }
  }

  if (budget) {
    const { byOutputId, default: defaultBudget } = resolveBudgetEnvelope(budget);
    if (byOutputId && Object.keys(byOutputId).length > 0) {
      for (const [outputId, outputBudget] of Object.entries(byOutputId)) {
        const outputMoments = momentsForOutput(moments, outputId, recipe);
        issues.push(
          ...validateOutputBudgetLimits(
            outputMoments,
            outputBudget,
            catalog,
            outputId,
          ),
        );
      }
    } else {
      issues.push(...validateGlobalBudgetLimits(moments, defaultBudget, catalog));
    }
  }

  issues.push(...validatePartialCrossfadePattern(recipe, moments));

  return issues;
}

const VOICE_PITCH_SHIFT_ID = "voice_pitch_shift";
const VOICE_PITCH_SEMITONE_MIN = -8;
const VOICE_PITCH_SEMITONE_MAX = 8;
const VOICE_PITCH_MAX_PER_OUTPUT = 2;

/**
 * V26-VOICE-01/02 — voice_pitch_shift semitone range and density per output.
 */
export function validateVoicePitchMoments(recipe) {
  const moments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.techniqueId === VOICE_PITCH_SHIFT_ID,
  );
  if (moments.length === 0) {
    return [];
  }

  const issues = [];
  const countByOutput = new Map();

  for (const moment of moments) {
    const outputId = moment.outputId ?? recipe.outputs?.[0]?.outputId ?? "unknown";
    countByOutput.set(outputId, (countByOutput.get(outputId) ?? 0) + 1);

    const semitones = moment.params?.semitones ?? 4;
    if (semitones < VOICE_PITCH_SEMITONE_MIN || semitones > VOICE_PITCH_SEMITONE_MAX) {
      issues.push({
        severity: "warning",
        code: "V26-VOICE-01",
        message: `voice_pitch_shift semitones ${semitones} poza zakresem ${VOICE_PITCH_SEMITONE_MIN}…${VOICE_PITCH_SEMITONE_MAX}`,
        outputId,
        momentId: moment.momentId,
      });
    }
  }

  for (const [outputId, count] of countByOutput) {
    if (count > VOICE_PITCH_MAX_PER_OUTPUT) {
      issues.push({
        severity: "warning",
        code: "V26-VOICE-02",
        message: `${count}× voice_pitch_shift na output ${outputId} (max ${VOICE_PITCH_MAX_PER_OUTPUT})`,
        outputId,
      });
    }
  }

  return issues;
}
