/**
 * Time-based jump cuts within a segment (P3-1: real cuts, not brightness pulse).
 */

export const DEFAULT_JUMP_CUT_GAP_SEC = 0.04;
const BOUNDARY_TOLERANCE_SEC = 0.12;

export function buildTimeCutKeepRanges(timeCuts, rangeStartSec, rangeEndSec) {
  if (!timeCuts?.length) {
    return null;
  }

  const sorted = [...timeCuts]
    .map((cut) => ({
      atSec: cut.atOutputSec - rangeStartSec,
      gapSec: cut.gapSec ?? DEFAULT_JUMP_CUT_GAP_SEC,
    }))
    .filter((cut) => cut.atSec > 0.01 && cut.atSec < (rangeEndSec - rangeStartSec) - 0.01)
    .sort((a, b) => a.atSec - b.atSec);

  if (sorted.length === 0) {
    return null;
  }

  const keepRanges = [];
  let cursor = 0;
  const span = rangeEndSec - rangeStartSec;

  for (const cut of sorted) {
    const gapStart = cut.atSec;
    const gapEnd = Math.min(span, gapStart + cut.gapSec);
    if (gapStart > cursor + 0.01) {
      keepRanges.push({ start: cursor, end: gapStart });
    }
    cursor = Math.max(cursor, gapEnd);
  }

  if (cursor < span - 0.01) {
    keepRanges.push({ start: cursor, end: span });
  }

  return keepRanges.length > 0 ? keepRanges : null;
}

export function applyVideoTimeCutsToRange({
  videoLabel = "[0:v]",
  timeCuts = [],
  rangeStartSec,
  rangeEndSec,
}) {
  const keepRanges = buildTimeCutKeepRanges(timeCuts, rangeStartSec, rangeEndSec);
  if (!keepRanges) {
    return `${videoLabel}setpts=PTS-STARTPTS[vout]`;
  }

  if (keepRanges.length === 1) {
    const range = keepRanges[0];
    return `${videoLabel}trim=start=${range.start}:end=${range.end},setpts=PTS-STARTPTS[vout]`;
  }

  const n = keepRanges.length;
  const splitOutputs = keepRanges.map((_, i) => `[vts${i}]`).join("");
  const split = `${videoLabel}split=${n}${splitOutputs}`;
  const parts = keepRanges.map((range, i) =>
    `[vts${i}]trim=start=${range.start}:end=${range.end},setpts=PTS-STARTPTS[vtc${i}]`,
  );
  const concatInputs = keepRanges.map((_, i) => `[vtc${i}]`).join("");
  return `${split};${parts.join(";")};${concatInputs}concat=n=${n}:v=1:a=0[vout]`;
}

export function applyAudioTimeCutsToRange({
  audioFilter = "[0:a]anull",
  timeCuts = [],
  rangeStartSec,
  rangeEndSec,
  singleInput = true,
}) {
  const keepRanges = buildTimeCutKeepRanges(timeCuts, rangeStartSec, rangeEndSec);
  if (!keepRanges) {
    const base = singleInput ? "[0:a]anull" : audioFilter;
    return `${base}[aout]`;
  }

  const inputLabel = singleInput ? "[0:a]" : audioFilter.replace(/\[aout\]$/, "");

  if (keepRanges.length === 1) {
    const range = keepRanges[0];
    return `${inputLabel}atrim=${range.start}:${range.end},asetpts=PTS-STARTPTS[aout]`;
  }

  // Intermediate labels ([aduck]/[async]/…) cannot be consumed twice — asplit first.
  const n = keepRanges.length;
  const splitOutputs = keepRanges.map((_, i) => `[ats${i}]`).join("");
  const split = `${inputLabel}asplit=${n}${splitOutputs}`;
  const parts = keepRanges.map((range, i) =>
    `[ats${i}]atrim=${range.start}:${range.end},asetpts=PTS-STARTPTS[atc${i}]`,
  );
  const concatInputs = keepRanges.map((_, i) => `[atc${i}]`).join("");
  return `${split};${parts.join(";")};${concatInputs}concat=n=${n}:v=0:a=1[aout]`;
}

function findSegmentForOutputSec(timeline, outputSec) {
  for (const segment of timeline ?? []) {
    const start = segment.outputStartSec ?? 0;
    const end = segment.outputEndSec ?? start;
    if (outputSec >= start && outputSec <= end + BOUNDARY_TOLERANCE_SEC) {
      return segment;
    }
  }
  return null;
}

/**
 * Materialize jump_cut / hard_cut_energy creativeMoments as segment timeCuts[].
 */
export function enrichJumpCutsAsTimeCuts(recipe) {
  const jumpTechniques = new Set(["jump_cut", "hard_cut_energy"]);
  const materializedMomentIds = new Set();
  const outputs = recipe.outputs ?? [];

  for (const output of outputs) {
    const timeline = output.timeline ?? [];
    for (const segment of timeline) {
      if (!segment.timeCuts) {
        segment.timeCuts = [];
      }
    }
  }

  const remainingMoments = [];

  for (const moment of recipe.creativeMoments ?? []) {
    if (!jumpTechniques.has(moment.techniqueId)) {
      remainingMoments.push(moment);
      continue;
    }

    const output = outputs.find((o) => o.outputId === moment.outputId) ?? outputs[0];
    const atSec = moment.outputStartSec ?? 0;
    const segment = findSegmentForOutputSec(output?.timeline, atSec);

    if (!segment) {
      remainingMoments.push(moment);
      continue;
    }

    const segStart = segment.outputStartSec ?? 0;
    const gapSec = moment.params?.gapSec
      ?? (moment.techniqueId === "hard_cut_energy" ? 0.03 : DEFAULT_JUMP_CUT_GAP_SEC);

    segment.timeCuts.push({
      atOutputSec: Math.round(atSec * 1000) / 1000,
      gapSec,
      reason: moment.techniqueId,
      momentId: moment.momentId,
    });
    materializedMomentIds.add(moment.momentId);
  }

  recipe.creativeMoments = remainingMoments;
  recipe.jumpCutMaterialization = {
    count: materializedMomentIds.size,
    momentIds: [...materializedMomentIds],
  };
  return recipe;
}
