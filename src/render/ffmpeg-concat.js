import fs from "node:fs";
import path from "node:path";
import { runFfmpeg, probeDuration } from "../lib/ffmpeg.js";
import { applyJlCutAudio, hasJlCutOverlap } from "./audio-jlcut.js";

const BOUNDARY_TOLERANCE_SEC = 0.1;
const DEFAULT_CROSSFADE_SEC = 0.3;
const DEFAULT_SNAP_TOLERANCE_SEC = 0.5;
const SNAP_EPSILON_SEC = 0.001;
const MIN_CROSSFADE_JOIN_DURATION_SEC = 0.5;

export function findCutOnBeatAtBoundary(creativeMoments, segments, toleranceSec = BOUNDARY_TOLERANCE_SEC) {
  if (!segments || segments.length < 2) {
    return null;
  }

  for (let i = 1; i < segments.length; i += 1) {
    const joinSec = segments[i].outputStartSec;
    const moment = (creativeMoments ?? []).find(
      (m) => m.techniqueId === "cut_on_beat"
        && Math.abs(m.outputStartSec - joinSec) <= toleranceSec,
    );
    if (moment) {
      return {
        boundaryIndex: i,
        joinSec,
        moment,
      };
    }
  }

  return null;
}

/**
 * Find cut_mid_sentence creativeMoment aligned with a segment join boundary.
 */
export function findCutMidSentenceAtBoundary(creativeMoments, segments, toleranceSec = BOUNDARY_TOLERANCE_SEC) {
  if (!segments || segments.length < 2) {
    return null;
  }

  for (let i = 1; i < segments.length; i += 1) {
    const joinSec = segments[i].outputStartSec;
    const moment = (creativeMoments ?? []).find(
      (m) => m.techniqueId === "cut_mid_sentence"
        && Math.abs(m.outputStartSec - joinSec) <= toleranceSec,
    );
    if (moment) {
      return {
        boundaryIndex: i,
        joinSec,
        moment,
      };
    }
  }

  return null;
}

export function resolveSegmentClipId(segment) {
  return segment?.audioRef?.clipId ?? segment?.videoRef?.clipId ?? null;
}

export function outputSecToSourceSec(segment, outputSec) {
  const segStart = segment.outputStartSec ?? 0;
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  return (outputSec - segStart) + audioIn;
}

export function sourceSecToOutputSec(segment, sourceSec) {
  const segStart = segment.outputStartSec ?? 0;
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  return segStart + (sourceSec - audioIn);
}

function resolveClipBeats(audioIndex, clipId) {
  const clip = audioIndex?.clips?.find((entry) => entry.clipId === clipId);
  const rawBeats = clip?.beats ?? clip?.beatTimes ?? clip?.beatTimestamps ?? [];
  return rawBeats.map((beat) => (typeof beat === "number" ? beat : beat?.timeSec)).filter(
    (timeSec) => Number.isFinite(timeSec),
  );
}

export function findNearestBeatTimeSec(beats, sourceTimeSec) {
  if (!beats?.length || !Number.isFinite(sourceTimeSec)) {
    return null;
  }

  let nearest = beats[0];
  let minDist = Math.abs(beats[0] - sourceTimeSec);
  for (const beat of beats) {
    const dist = Math.abs(beat - sourceTimeSec);
    if (dist < minDist) {
      minDist = dist;
      nearest = beat;
    }
  }

  return { beatSourceSec: nearest, distanceSec: minDist };
}

/**
 * Compute beat-aligned join snap for a boundary cut_on_beat moment.
 */
export function computeBeatSnapAtBoundary({
  moment,
  segments,
  boundaryIndex,
  audioIndex,
}) {
  if (!moment || boundaryIndex < 1 || boundaryIndex >= segments.length) {
    return null;
  }

  const outgoing = segments[boundaryIndex - 1];
  const clipId = resolveSegmentClipId(outgoing);
  const beats = resolveClipBeats(audioIndex, clipId);
  if (beats.length === 0) {
    return null;
  }

  const originalJoinSec = segments[boundaryIndex].outputStartSec;
  const sourceTimeSec = outputSecToSourceSec(outgoing, originalJoinSec);
  const nearest = findNearestBeatTimeSec(beats, sourceTimeSec);
  if (!nearest) {
    return null;
  }

  const snapToleranceSec = moment.params?.snapToleranceSec ?? DEFAULT_SNAP_TOLERANCE_SEC;
  if (nearest.distanceSec > snapToleranceSec) {
    return null;
  }

  const snappedJoinSec = sourceSecToOutputSec(outgoing, nearest.beatSourceSec);
  const deltaSec = snappedJoinSec - originalJoinSec;
  const base = {
    boundaryIndex,
    originalJoinSec,
    snappedJoinSec,
    deltaSec,
    beatSourceSec: nearest.beatSourceSec,
    clipId,
    moment,
  };

  if (Math.abs(deltaSec) <= SNAP_EPSILON_SEC) {
    return { ...base, status: "already_aligned" };
  }

  return { ...base, status: "snapped" };
}

/**
 * Collect beat snaps for all boundary-aligned cut_on_beat moments.
 */
export function collectBeatSnapsAtBoundaries(creativeMoments, segments, audioIndex) {
  if (!audioIndex?.clips?.length || hasJlCutOverlap(segments)) {
    return { beatSnaps: [], alreadyAligned: [] };
  }

  const beatSnaps = [];
  const alreadyAligned = [];
  for (let i = 1; i < (segments?.length ?? 0); i += 1) {
    const joinSec = segments[i].outputStartSec;
    const moment = (creativeMoments ?? []).find(
      (m) => m.techniqueId === "cut_on_beat"
        && Math.abs(m.outputStartSec - joinSec) <= BOUNDARY_TOLERANCE_SEC,
    );
    if (!moment) {
      continue;
    }

    const snap = computeBeatSnapAtBoundary({
      moment,
      segments,
      boundaryIndex: i,
      audioIndex,
    });
    if (!snap) {
      continue;
    }
    if (snap.status === "already_aligned") {
      alreadyAligned.push(snap);
    } else {
      beatSnaps.push(snap);
    }
  }

  return { beatSnaps, alreadyAligned };
}

async function trimSegmentEnd(inputPath, outputPath, trimSec, { encodeProfile, runFfmpegFn }) {
  const durationSec = await probeDuration(inputPath);
  const keepSec = Math.max(0.05, durationSec - trimSec);
  await runFfmpegFn(
    [
      "-y",
      "-i", inputPath,
      "-t", String(keepSec),
      "-c:v", encodeProfile.videoCodec,
      "-preset", encodeProfile.preset,
      "-crf", String(encodeProfile.crf),
      "-c:a", encodeProfile.audioCodec,
      "-b:a", encodeProfile.audioBitrate,
      "-movflags", "+faststart",
      outputPath,
    ],
    { label: "trim segment end for beat snap" },
  );
}

async function trimSegmentStart(inputPath, outputPath, trimSec, { encodeProfile, runFfmpegFn }) {
  await runFfmpegFn(
    [
      "-y",
      "-ss", String(Math.max(0, trimSec)),
      "-i", inputPath,
      "-c:v", encodeProfile.videoCodec,
      "-preset", encodeProfile.preset,
      "-crf", String(encodeProfile.crf),
      "-c:a", encodeProfile.audioCodec,
      "-b:a", encodeProfile.audioBitrate,
      "-movflags", "+faststart",
      outputPath,
    ],
    { label: "trim segment start for beat snap" },
  );
}

/**
 * Apply beat snap trims to segment files (mutates paths in place via temp files).
 */
export async function applyBeatSnapTrims(segmentPaths, beatSnaps, tmpDir, {
  encodeProfile,
  runFfmpegFn = runFfmpeg,
} = {}) {
  if (!beatSnaps?.length || !encodeProfile) {
    return segmentPaths;
  }

  const adjusted = [...segmentPaths];
  for (const snap of beatSnaps) {
    const { boundaryIndex, deltaSec } = snap;
    if (deltaSec < -SNAP_EPSILON_SEC) {
      const trimSec = Math.abs(deltaSec);
      const srcPath = adjusted[boundaryIndex - 1];
      const outPath = path.join(tmpDir, `beat_snap_end_${boundaryIndex - 1}.mp4`);
      await trimSegmentEnd(srcPath, outPath, trimSec, { encodeProfile, runFfmpegFn });
      adjusted[boundaryIndex - 1] = outPath;
    } else if (deltaSec > SNAP_EPSILON_SEC) {
      const trimSec = deltaSec;
      const srcPath = adjusted[boundaryIndex];
      const outPath = path.join(tmpDir, `beat_snap_start_${boundaryIndex}.mp4`);
      await trimSegmentStart(srcPath, outPath, trimSec, { encodeProfile, runFfmpegFn });
      adjusted[boundaryIndex] = outPath;
    }
  }

  return adjusted;
}

/**
 * Find crossfade creativeMoment aligned with a segment join boundary.
 */
export function findCrossfadeAtBoundary(creativeMoments, segments) {
  const boundaries = collectCrossfadesAtBoundaries(creativeMoments, segments);
  return boundaries.find(Boolean) ?? null;
}

/**
 * Per-boundary crossfade config (index i = join between segments i and i+1).
 */
export function collectCrossfadesAtBoundaries(creativeMoments, segments) {
  const count = Math.max(0, (segments?.length ?? 0) - 1);
  const result = Array.from({ length: count }, () => null);
  if (!segments || segments.length < 2) {
    return result;
  }

  for (let i = 1; i < segments.length; i += 1) {
    const joinSec = segments[i].outputStartSec;
    const moment = (creativeMoments ?? []).find(
      (m) => m.techniqueId === "crossfade"
        && Math.abs(m.outputStartSec - joinSec) <= BOUNDARY_TOLERANCE_SEC,
    );
    if (moment) {
      result[i - 1] = {
        boundaryIndex: i,
        joinSec,
        durationSec: moment.params?.durationSec ?? DEFAULT_CROSSFADE_SEC,
        moment,
      };
    }
  }

  return result;
}

export function resolveSegmentDurations(segments) {
  return (segments ?? []).map(
    (segment) => (segment.outputEndSec ?? 0) - (segment.outputStartSec ?? 0),
  );
}

export function segmentDurationSec(segment) {
  return (segment?.outputEndSec ?? 0) - (segment?.outputStartSec ?? 0);
}

/**
 * Per-join video crossfade eligibility (expanded for J/L + crossfade coexistence).
 * - aroll → aroll on the same source clip
 * - broll → aroll when both segments exceed 0.5 s
 */
export function isJoinCrossfadeEligible(outgoing, incoming) {
  if (!outgoing || !incoming) {
    return false;
  }

  const outRole = outgoing.segmentRole ?? "aroll";
  const inRole = incoming.segmentRole ?? "aroll";
  const outDur = segmentDurationSec(outgoing);
  const inDur = segmentDurationSec(incoming);
  const outClip = resolveSegmentClipId(outgoing);
  const inClip = resolveSegmentClipId(incoming);

  if (outRole === "aroll" && inRole === "aroll" && outClip && outClip === inClip) {
    return true;
  }

  if (
    outRole === "broll"
    && inRole === "aroll"
    && outDur > MIN_CROSSFADE_JOIN_DURATION_SEC
    && inDur > MIN_CROSSFADE_JOIN_DURATION_SEC
  ) {
    return true;
  }

  return false;
}

/**
 * Crossfade boundaries eligible for video xfade when J/L audio overlap is present.
 * Audio stays on the J/L path; only video may xfade at these joins.
 */
export function resolveJlVideoCrossfadeBoundaries(creativeMoments, segments) {
  const boundaries = collectCrossfadesAtBoundaries(creativeMoments, segments);
  return boundaries.map((cf, boundaryIndex) => {
    if (!cf) {
      return null;
    }
    return isJoinCrossfadeEligible(segments[boundaryIndex], segments[boundaryIndex + 1])
      ? cf
      : null;
  });
}

/**
 * Offset for xfade at a crossfade boundary (1-based boundaryIndex).
 */
export function computeXfadeOffsetAtBoundary(segmentDurations, crossfadeAtBoundaries, boundaryIndex) {
  const cf = crossfadeAtBoundaries[boundaryIndex - 1];
  if (!cf) {
    return null;
  }

  let runningDur = segmentDurations[0] ?? 0;
  for (let b = 0; b < boundaryIndex - 1; b += 1) {
    const prevCf = crossfadeAtBoundaries[b];
    if (prevCf) {
      const d = Math.max(0.05, prevCf.durationSec);
      runningDur += (segmentDurations[b + 1] ?? 0) - d;
    } else {
      runningDur += segmentDurations[b + 1] ?? 0;
    }
  }

  const d = Math.max(0.05, cf.durationSec);
  return Math.max(0, runningDur - d);
}

/**
 * Build filter_complex for N-segment chained xfade/acrossfade with optional hard cuts.
 */
export function buildMultiSegmentXfadeFilterComplex({ segmentDurations, crossfadeAtBoundaries }) {
  const n = segmentDurations.length;
  const filters = [];

  for (let i = 0; i < n; i += 1) {
    filters.push(`[${i}:v]setpts=PTS-STARTPTS[s${i}v]`);
    filters.push(`[${i}:a]asetpts=PTS-STARTPTS[s${i}a]`);
  }

  let curV = "s0v";
  let curA = "s0a";
  let curDur = segmentDurations[0] ?? 0;
  let stepIdx = 0;

  for (let b = 0; b < n - 1; b += 1) {
    const nextIdx = b + 1;
    const cf = crossfadeAtBoundaries[b];
    const outV = `m${stepIdx}v`;
    const outA = `m${stepIdx}a`;

    if (cf) {
      const d = Math.max(0.05, cf.durationSec);
      const offset = Math.max(0, curDur - d);
      filters.push(`[${curV}][s${nextIdx}v]xfade=transition=fade:duration=${d}:offset=${offset}[${outV}]`);
      filters.push(`[${curA}][s${nextIdx}a]acrossfade=d=${d}:c1=tri:c2=tri[${outA}]`);
      curDur += (segmentDurations[nextIdx] ?? 0) - d;
    } else {
      filters.push(`[${curV}][s${nextIdx}v]concat=n=2:v=1:a=0[${outV}]`);
      filters.push(`[${curA}][s${nextIdx}a]concat=n=2:v=0:a=1[${outA}]`);
      curDur += segmentDurations[nextIdx] ?? 0;
    }

    curV = outV;
    curA = outA;
    stepIdx += 1;
  }

  return {
    filterComplex: filters.join(";"),
    videoMap: `[${curV}]`,
    audioMap: `[${curA}]`,
  };
}

/**
 * Build filter_complex for 2-segment video xfade + audio acrossfade.
 */
export function buildTwoSegmentXfadeFilterComplex({ durationSec, offsetSec }) {
  const d = Math.max(0.05, durationSec);
  const offset = Math.max(0, offsetSec);

  return {
    filterComplex: [
      "[0:v]setpts=PTS-STARTPTS[v0]",
      "[1:v]setpts=PTS-STARTPTS[v1]",
      `[v0][v1]xfade=transition=fade:duration=${d}:offset=${offset}[outv]`,
      "[0:a]asetpts=PTS-STARTPTS[a0]",
      "[1:a]asetpts=PTS-STARTPTS[a1]",
      `[a0][a1]acrossfade=d=${d}:c1=tri:c2=tri[outa]`,
    ].join(";"),
    videoMap: "[outv]",
    audioMap: "[outa]",
  };
}

async function runXfadeFilterComplex(segmentPaths, built, outputPath, {
  encodeProfile,
  runFfmpegFn,
  label,
}) {
  const args = ["-y"];
  for (const segmentPath of segmentPaths) {
    args.push("-i", segmentPath);
  }
  args.push(
    "-filter_complex", built.filterComplex,
    "-map", built.videoMap,
    "-map", built.audioMap,
    "-c:v", encodeProfile.videoCodec,
    "-preset", encodeProfile.preset,
    "-crf", String(encodeProfile.crf),
    "-c:a", encodeProfile.audioCodec,
    "-b:a", encodeProfile.audioBitrate,
    "-movflags", "+faststart",
    outputPath,
  );
  await runFfmpegFn(args, { label });
}

async function applyTwoSegmentXfade(segmentPaths, segments, outputPath, {
  encodeProfile,
  crossfade,
  runFfmpegFn = runFfmpeg,
}) {
  const seg0Dur = (segments[0].outputEndSec ?? 0) - (segments[0].outputStartSec ?? 0);
  const durationSec = crossfade.durationSec;
  const offsetSec = Math.max(0, seg0Dur - durationSec);
  const built = buildTwoSegmentXfadeFilterComplex({ durationSec, offsetSec });

  await runXfadeFilterComplex(segmentPaths, built, outputPath, {
    encodeProfile,
    runFfmpegFn,
    label: "2-segment xfade concat",
  });
}

async function applyMultiSegmentXfade(segmentPaths, segments, outputPath, {
  encodeProfile,
  crossfadeAtBoundaries,
  runFfmpegFn = runFfmpeg,
}) {
  const segmentDurations = resolveSegmentDurations(segments);
  const built = buildMultiSegmentXfadeFilterComplex({
    segmentDurations,
    crossfadeAtBoundaries,
  });

  await runXfadeFilterComplex(segmentPaths, built, outputPath, {
    encodeProfile,
    runFfmpegFn,
    label: "multi-segment xfade concat",
  });
}

/**
 * True when concat can apply real xfade/acrossfade (exactly 2 segments, aligned moment, no J/L).
 */
export function isTwoSegmentCrossfadeEligible(segmentPaths, segments, creativeMoments) {
  if (!segmentPaths || segmentPaths.length !== 2) {
    return false;
  }
  if (hasJlCutOverlap(segments)) {
    return false;
  }
  return Boolean(findCrossfadeAtBoundary(creativeMoments, segments));
}

/**
 * True when 3+ segments can use chained xfade (one crossfade join or crossfade at every join).
 */
export function isMultiSegmentCrossfadeEligible(segmentPaths, segments, creativeMoments) {
  if (!segmentPaths || segmentPaths.length < 3) {
    return false;
  }
  if (hasJlCutOverlap(segments)) {
    return false;
  }

  const boundaries = collectCrossfadesAtBoundaries(creativeMoments, segments);
  const crossfadeCount = boundaries.filter(Boolean).length;
  if (crossfadeCount === 0) {
    return false;
  }

  const numBoundaries = segmentPaths.length - 1;
  return crossfadeCount === 1 || crossfadeCount === numBoundaries;
}

export function isCrossfadeEligible(segmentPaths, segments, creativeMoments) {
  return isTwoSegmentCrossfadeEligible(segmentPaths, segments, creativeMoments)
    || isMultiSegmentCrossfadeEligible(segmentPaths, segments, creativeMoments);
}

const CROSSFADE_JL_INELIGIBLE_JOIN_MESSAGE =
  "J/L overlap: join not eligible for video crossfade (requires aroll→aroll same clip, or broll→aroll with both segments >0.5s)";
const CROSSFADE_PARTIAL_BOUNDARIES_MESSAGE =
  "partial crossfade pattern: requires crossfade at every internal join or exactly one join";

/**
 * True when a boundary crossfade exists but concat did not apply xfade (defer to warning, not creative).
 */
export function shouldDeferCrossfadeToCreative(creativeMoments, segments, appliedCrossfade) {
  if (appliedCrossfade) {
    return false;
  }
  return Boolean(findCrossfadeAtBoundary(creativeMoments, segments));
}

/**
 * Human-readable reason when concat could not apply crossfade at a segment boundary.
 */
export function getCrossfadeNotAppliedReason(segmentPaths, segments, creativeMoments) {
  if (!findCrossfadeAtBoundary(creativeMoments, segments)) {
    return null;
  }

  const boundaries = collectCrossfadesAtBoundaries(creativeMoments, segments);
  const crossfadeCount = boundaries.filter(Boolean).length;

  if (hasJlCutOverlap(segments)) {
    const hasEligibleJlJoin = boundaries.some(
      (cf, boundaryIndex) => cf
        && isJoinCrossfadeEligible(segments[boundaryIndex], segments[boundaryIndex + 1]),
    );
    if (hasEligibleJlJoin) {
      return null;
    }
    return CROSSFADE_JL_INELIGIBLE_JOIN_MESSAGE;
  }

  if (isCrossfadeEligible(segmentPaths, segments, creativeMoments)) {
    return null;
  }

  const numBoundaries = (segmentPaths?.length ?? 0) - 1;
  if (numBoundaries >= 2 && crossfadeCount > 1 && crossfadeCount < numBoundaries) {
    return `${CROSSFADE_PARTIAL_BOUNDARIES_MESSAGE} (${crossfadeCount}/${numBoundaries} joins)`;
  }

  if (numBoundaries >= 2 && crossfadeCount > 0 && crossfadeCount < numBoundaries) {
    return CROSSFADE_PARTIAL_BOUNDARIES_MESSAGE;
  }

  return CROSSFADE_PARTIAL_BOUNDARIES_MESSAGE;
}

/**
 * After concat: drop applied crossfade / cut_on_beat from creative pass; emit warnings.
 */
export function resolvePostConcatCreativeMoments({
  creativeMoments = [],
  segments,
  segmentPaths,
  appliedCrossfade,
  appliedBeatSnaps = [],
  alreadyAlignedBeatSnaps = [],
}) {
  const warnings = [];
  let moments = creativeMoments;

  if (shouldDeferCrossfadeToCreative(creativeMoments, segments, appliedCrossfade)) {
    const reason = getCrossfadeNotAppliedReason(segmentPaths, segments, creativeMoments);
    if (reason) {
      warnings.push({
        code: "CROSSFADE_NOT_APPLIED",
        techniqueId: "crossfade",
        message: reason,
      });
    }
    moments = moments.filter((m) => m.techniqueId !== "crossfade");
  } else if (appliedCrossfade) {
    moments = moments.filter((m) => m.techniqueId !== "crossfade");
  }

  for (const snap of appliedBeatSnaps) {
    warnings.push({
      code: "CUT_ON_BEAT_SNAPPED",
      techniqueId: "cut_on_beat",
      message: `join ${snap.originalJoinSec.toFixed(3)}s → ${snap.snappedJoinSec.toFixed(3)}s (beat ${snap.beatSourceSec.toFixed(3)}s, clip ${snap.clipId})`,
      boundaryIndex: snap.boundaryIndex,
      originalJoinSec: snap.originalJoinSec,
      snappedJoinSec: snap.snappedJoinSec,
      deltaSec: snap.deltaSec,
      beatSourceSec: snap.beatSourceSec,
      clipId: snap.clipId,
    });
  }

  for (const snap of alreadyAlignedBeatSnaps) {
    warnings.push({
      code: "CUT_ON_BEAT_ALREADY_ALIGNED",
      techniqueId: "cut_on_beat",
      message: `join ${snap.originalJoinSec.toFixed(3)}s already on beat ${snap.beatSourceSec.toFixed(3)}s (clip ${snap.clipId})`,
      boundaryIndex: snap.boundaryIndex,
      originalJoinSec: snap.originalJoinSec,
      beatSourceSec: snap.beatSourceSec,
      clipId: snap.clipId,
    });
  }

  const hasBoundaryCutOnBeat = Boolean(findCutOnBeatAtBoundary(creativeMoments, segments));
  if (
    hasBoundaryCutOnBeat
    && appliedBeatSnaps.length === 0
    && alreadyAlignedBeatSnaps.length === 0
    && !hasJlCutOverlap(segments)
  ) {
    const reason = !segmentPaths || segmentPaths.length < 2
      ? "requires segment join with audioIndex beats"
      : "no beat within snapToleranceSec at boundary";
    warnings.push({
      code: "CUT_ON_BEAT_NOT_APPLIED",
      techniqueId: "cut_on_beat",
      message: reason,
    });
  }

  if (hasBoundaryCutOnBeat || appliedBeatSnaps.length > 0 || alreadyAlignedBeatSnaps.length > 0) {
    moments = moments.filter((m) => m.techniqueId !== "cut_on_beat");
  }

  return { moments, warnings };
}

/**
 * Concat segment MP4s into one timeline file.
 * @returns {{ outputPath: string, appliedCrossfade: boolean, appliedBeatSnaps: object[], alreadyAlignedBeatSnaps: object[] }}
 */
export async function concatSegmentFiles(segmentPaths, outputPath, {
  encodeProfile,
  segments,
  creativeMoments,
  audioIndex,
  tmpDir,
  runFfmpegFn = runFfmpeg,
} = {}) {
  if (segmentPaths.length === 0) {
    throw new Error("concatSegmentFiles: brak segmentów");
  }

  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], outputPath);
    return { outputPath, appliedCrossfade: false, appliedBeatSnaps: [], alreadyAlignedBeatSnaps: [] };
  }

  const { beatSnaps, alreadyAligned } = collectBeatSnapsAtBoundaries(creativeMoments, segments, audioIndex);
  let pathsToConcat = segmentPaths;
  if (beatSnaps.length > 0 && encodeProfile && tmpDir) {
    pathsToConcat = await applyBeatSnapTrims(segmentPaths, beatSnaps, tmpDir, {
      encodeProfile,
      runFfmpegFn,
    });
  }

  const crossfadeAtBoundaries = collectCrossfadesAtBoundaries(creativeMoments, segments);
  const crossfade = crossfadeAtBoundaries.find(Boolean);
  const hasJlCut = hasJlCutOverlap(segments);
  const jlVideoCrossfadeAtBoundaries = hasJlCut
    ? resolveJlVideoCrossfadeBoundaries(creativeMoments, segments)
    : null;
  const hasJlVideoCrossfade = Boolean(jlVideoCrossfadeAtBoundaries?.some(Boolean));

  // J/L + crossfade at the same join: keep J/L audio (acrossfade/overlap), video xfade when eligible.
  if (hasJlVideoCrossfade) {
    await applyJlCutAudio(pathsToConcat, segments, outputPath, {
      encodeProfile,
      crossfadeAtBoundaries: jlVideoCrossfadeAtBoundaries,
      runFfmpegFn,
    });
    return {
      outputPath,
      appliedCrossfade: true,
      appliedBeatSnaps: [],
      alreadyAlignedBeatSnaps: [],
    };
  }

  if (!hasJlCut && crossfade) {
    if (pathsToConcat.length === 2) {
      await applyTwoSegmentXfade(pathsToConcat, segments, outputPath, {
        encodeProfile,
        crossfade,
        runFfmpegFn,
      });
      return {
        outputPath,
        appliedCrossfade: true,
        appliedBeatSnaps: beatSnaps,
        alreadyAlignedBeatSnaps: alreadyAligned,
      };
    }

    if (isMultiSegmentCrossfadeEligible(pathsToConcat, segments, creativeMoments)) {
      await applyMultiSegmentXfade(pathsToConcat, segments, outputPath, {
        encodeProfile,
        crossfadeAtBoundaries,
        runFfmpegFn,
      });
      return {
        outputPath,
        appliedCrossfade: true,
        appliedBeatSnaps: beatSnaps,
        alreadyAlignedBeatSnaps: alreadyAligned,
      };
    }
  }

  const listPath = `${outputPath}.concat.txt`;
  const listContent = pathsToConcat.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(listPath, listContent);

  try {
    if (hasJlCut) {
      await applyJlCutAudio(pathsToConcat, segments, outputPath, { encodeProfile, runFfmpegFn });
      return {
        outputPath,
        appliedCrossfade: false,
        appliedBeatSnaps: [],
        alreadyAlignedBeatSnaps: [],
      };
    }

    await runFfmpegFn(
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        outputPath,
      ],
      { label: "concat segments" },
    );
  } finally {
    if (fs.existsSync(listPath)) {
      fs.unlinkSync(listPath);
    }
  }

  return {
    outputPath,
    appliedCrossfade: false,
    appliedBeatSnaps: beatSnaps,
    alreadyAlignedBeatSnaps: alreadyAligned,
  };
}

export function cleanupTempDir(tmpDir) {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
