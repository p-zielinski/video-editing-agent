/**
 * Unified boundary compositor — single planner for crossfade / J-L / beat snap at segment joins.
 */
import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { applyJlCutAudio, hasJlCutOverlap } from "./audio-jlcut.js";
import {
  applyBeatSnapTrims,
  buildHardConcatFilterComplex,
  buildMultiSegmentXfadeFilterComplex,
  buildTwoSegmentXfadeFilterComplex,
  collectBeatSnapsAtBoundaries,
  collectCrossfadesAtBoundaries,
  isMultiSegmentCrossfadeEligible,
  isTwoSegmentCrossfadeEligible,
  resolveJlVideoCrossfadeBoundaries,
  resolveSegmentDurations,
} from "./ffmpeg-concat.js";

async function applyTwoSegmentXfade(segmentPaths, segments, outputPath, {
  encodeProfile,
  crossfade,
  runFfmpegFn,
}) {
  const seg0Dur = (segments[0].outputEndSec ?? 0) - (segments[0].outputStartSec ?? 0);
  const durationSec = crossfade.durationSec;
  const offsetSec = Math.max(0, seg0Dur - durationSec);
  const built = buildTwoSegmentXfadeFilterComplex({
    durationSec,
    offsetSec,
    transitionType: crossfade.transitionType ?? "fade",
  });

  const args = ["-y", "-i", segmentPaths[0], "-i", segmentPaths[1],
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
  ];
  await runFfmpegFn(args, { label: "2-segment xfade concat" });
}

async function applyMultiSegmentXfade(segmentPaths, segments, outputPath, {
  encodeProfile,
  crossfadeAtBoundaries,
  runFfmpegFn,
}) {
  const segmentDurations = resolveSegmentDurations(segments);
  const built = buildMultiSegmentXfadeFilterComplex({
    segmentDurations,
    crossfadeAtBoundaries,
  });

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
  await runFfmpegFn(args, { label: "multi-segment xfade concat" });
}

async function applyHardConcat(segmentPaths, outputPath, {
  encodeProfile,
  runFfmpegFn,
}) {
  const built = buildHardConcatFilterComplex(segmentPaths.length);
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
  await runFfmpegFn(args, { label: "hard concat segments" });
}

/**
 * Plan how to join segment files (beat snap, crossfade, J/L, hard concat).
 */
export function planBoundaryConcat({
  segmentPaths,
  segments,
  creativeMoments,
  audioIndex,
}) {
  const { beatSnaps, alreadyAligned } = collectBeatSnapsAtBoundaries(
    creativeMoments,
    segments,
    audioIndex,
  );
  const crossfadeAtBoundaries = collectCrossfadesAtBoundaries(creativeMoments, segments);
  const crossfade = crossfadeAtBoundaries.find(Boolean) ?? null;
  const hasJlCut = hasJlCutOverlap(segments);
  const jlVideoCrossfadeAtBoundaries = hasJlCut
    ? resolveJlVideoCrossfadeBoundaries(creativeMoments, segments)
    : null;
  const hasJlVideoCrossfade = Boolean(jlVideoCrossfadeAtBoundaries?.some(Boolean));

  let strategy = "hard_concat";
  if (hasJlVideoCrossfade) {
    strategy = "jl_video_xfade";
  } else if (!hasJlCut && crossfade) {
    if (segmentPaths.length === 2
      && isTwoSegmentCrossfadeEligible(segmentPaths, segments, creativeMoments)) {
      strategy = "two_xfade";
    } else if (isMultiSegmentCrossfadeEligible(segmentPaths, segments, creativeMoments)) {
      strategy = "multi_xfade";
    }
  } else if (hasJlCut) {
    strategy = "jl_audio";
  }

  return {
    strategy,
    beatSnaps,
    alreadyAligned,
    crossfadeAtBoundaries,
    crossfade,
    hasJlCut,
    jlVideoCrossfadeAtBoundaries,
    hasJlVideoCrossfade,
  };
}

/**
 * Execute boundary concat plan (unified engine entry).
 */
export async function executeBoundaryConcat(segmentPaths, outputPath, {
  encodeProfile,
  segments,
  creativeMoments,
  audioIndex,
  tmpDir,
  runFfmpegFn = runFfmpeg,
} = {}) {
  if (segmentPaths.length === 0) {
    throw new Error("executeBoundaryConcat: brak segmentów");
  }

  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], outputPath);
    return {
      outputPath,
      appliedCrossfade: false,
      appliedBeatSnaps: [],
      alreadyAlignedBeatSnaps: [],
      strategy: "single_segment",
    };
  }

  const plan = planBoundaryConcat({
    segmentPaths,
    segments,
    creativeMoments,
    audioIndex,
  });

  let pathsToConcat = segmentPaths;
  if (plan.beatSnaps.length > 0 && encodeProfile && tmpDir) {
    pathsToConcat = await applyBeatSnapTrims(segmentPaths, plan.beatSnaps, tmpDir, {
      encodeProfile,
      runFfmpegFn,
    });
  }

  if (plan.strategy === "jl_video_xfade") {
    await applyJlCutAudio(pathsToConcat, segments, outputPath, {
      encodeProfile,
      crossfadeAtBoundaries: plan.jlVideoCrossfadeAtBoundaries,
      runFfmpegFn,
    });
    return {
      outputPath,
      appliedCrossfade: true,
      appliedBeatSnaps: [],
      alreadyAlignedBeatSnaps: [],
      strategy: plan.strategy,
    };
  }

  if (plan.strategy === "two_xfade" && plan.crossfade) {
    await applyTwoSegmentXfade(pathsToConcat, segments, outputPath, {
      encodeProfile,
      crossfade: plan.crossfade,
      runFfmpegFn,
    });
    return {
      outputPath,
      appliedCrossfade: true,
      appliedBeatSnaps: plan.beatSnaps,
      alreadyAlignedBeatSnaps: plan.alreadyAligned,
      strategy: plan.strategy,
    };
  }

  if (plan.strategy === "multi_xfade") {
    await applyMultiSegmentXfade(pathsToConcat, segments, outputPath, {
      encodeProfile,
      crossfadeAtBoundaries: plan.crossfadeAtBoundaries,
      runFfmpegFn,
    });
    return {
      outputPath,
      appliedCrossfade: true,
      appliedBeatSnaps: plan.beatSnaps,
      alreadyAlignedBeatSnaps: plan.alreadyAligned,
      strategy: plan.strategy,
    };
  }

  if (plan.strategy === "jl_audio") {
    await applyJlCutAudio(pathsToConcat, segments, outputPath, { encodeProfile, runFfmpegFn });
    return {
      outputPath,
      appliedCrossfade: false,
      appliedBeatSnaps: [],
      alreadyAlignedBeatSnaps: [],
      strategy: plan.strategy,
    };
  }

  await applyHardConcat(pathsToConcat, outputPath, { encodeProfile, runFfmpegFn });

  return {
    outputPath,
    appliedCrossfade: false,
    appliedBeatSnaps: plan.beatSnaps,
    alreadyAlignedBeatSnaps: plan.alreadyAligned,
    strategy: plan.strategy,
  };
}
