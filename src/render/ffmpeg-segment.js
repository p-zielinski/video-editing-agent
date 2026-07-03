import path from "node:path";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { resolveSegmentOutputDuration } from "../lib/build-output-timeline.js";
import { buildSegmentVideoFilter } from "./ffmpeg-reframe.js";
import { applyAudioCutsToRange, applyVideoCutsToRange } from "./audio-cuts.js";
import {
  buildAtempoFilterChain,
  buildSourceVolumeFilter,
  buildVideoOnlyPadFilter,
  resolveEffectiveSpeed,
  shouldApplyAudioSpeed,
  shouldOmitShortestForVideoOnlySpeed,
} from "./speed-transform.js";

function segmentDurationSec(segment, context) {
  const wordIndex = resolveWordIndexForSegment(segment, context);
  return resolveSegmentOutputDuration(segment, { wordIndex });
}

export function resolveWordIndexForSegment(segment, context) {
  const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
  return clipId ? context?.wordIndexes?.[clipId] ?? null : null;
}

export function collectBrollDesyncWarning(segment, videoDur, audioDur) {
  if (segment.segmentRole !== "broll") {
    return null;
  }
  const delta = Math.abs(videoDur - audioDur);
  if (delta <= 0.5) {
    return null;
  }
  return {
    code: "broll_av_desync",
    segmentId: segment.segmentId,
    message:
      `B-roll ${segment.segmentId}: różnica video/audio ${delta.toFixed(2)}s `
      + `(video=${videoDur.toFixed(2)}s, audio=${audioDur.toFixed(2)}s)`,
    deltaSec: delta,
  };
}

export function buildVideoSyncFilter(segment, videoDur, audioDur) {
  const syncMode = segment.syncMode ?? "align_start";
  if (Math.abs(videoDur - audioDur) <= 0.01) {
    return null;
  }

  if (syncMode === "fit_video_to_audio") {
    if (videoDur > audioDur) {
      return `trim=duration=${audioDur},setpts=PTS-STARTPTS`;
    }
    const factor = audioDur / videoDur;
    return `setpts=PTS*${factor}`;
  }

  if (syncMode === "align_end") {
    if (videoDur > audioDur) {
      const trimStart = videoDur - audioDur;
      return `trim=start=${trimStart}:end=${videoDur},setpts=PTS-STARTPTS`;
    }
    const padStart = audioDur - videoDur;
    return `tpad=start_duration=${padStart}:start_mode=add,trim=duration=${audioDur},setpts=PTS-STARTPTS`;
  }

  return null;
}

/** Sample count for apad pad_len; prefer pad_dur in buildAudioSyncFilter when possible. */
export function audioPadSamplesForDuration(padSec, sampleRate = 48000) {
  return Math.ceil(padSec * sampleRate);
}

export function buildAudioSyncFilter(segment, videoDur, audioDur, options = {}) {
  const syncMode = segment.syncMode ?? "align_start";
  if (Math.abs(videoDur - audioDur) <= 0.01) {
    return null;
  }

  if (syncMode === "fit_audio_to_video") {
    if (audioDur > videoDur) {
      return `atrim=0:${videoDur},asetpts=PTS-STARTPTS`;
    }
    const padSec = videoDur - audioDur;
    // pad_dur is sample-rate independent; use audioPadSamplesForDuration(padSec, sampleRate)
    // with options.sampleRate ?? segment.audioSampleRate ?? 48000 when pad_len is required.
    return `apad=pad_dur=${padSec},atrim=0:${videoDur},asetpts=PTS-STARTPTS`;
  }

  if (syncMode === "align_end") {
    if (audioDur > videoDur) {
      const trimStart = audioDur - videoDur;
      return `atrim=start=${trimStart}:end=${audioDur},asetpts=PTS-STARTPTS`;
    }
    const delayMs = Math.round((videoDur - audioDur) * 1000);
    return `adelay=${delayMs}|${delayMs},atrim=0:${videoDur},asetpts=PTS-STARTPTS`;
  }

  return null;
}

export function buildCombinedAudioFilter(segment, videoDur, audioDur, options = {}) {
  const speed = resolveEffectiveSpeed(segment);
  const applyAudioSpeed = shouldApplyAudioSpeed(segment, speed);
  const syncMode = segment.syncMode ?? "align_start";
  const skipAudioFitSync = speed !== 1 && applyAudioSpeed && syncMode === "fit_audio_to_video";

  const audioSyncFilter = skipAudioFitSync
    ? null
    : buildAudioSyncFilter(segment, videoDur, audioDur, options);
  const audioSpeedFilter = applyAudioSpeed ? buildAtempoFilterChain(speed) : null;
  const audioVolumeFilter = buildSourceVolumeFilter(segment.sourceVolumeDb);

  const parts = [audioSyncFilter, audioSpeedFilter, audioVolumeFilter].filter(Boolean);
  return parts.length > 0 ? parts.join(",") : null;
}

function isJlCutBorrowedAudio(segment) {
  return segment.audioPolicy === "from_prev" || segment.audioPolicy === "from_next";
}

function pushShortestIfNeeded(args, segment) {
  if (!shouldOmitShortestForVideoOnlySpeed(segment)) {
    args.push("-shortest");
  }
}

export function buildLavfiColorInput(durationSec, dimensions = {}) {
  const w = dimensions.width ?? 1920;
  const h = dimensions.height ?? 1080;
  const d = Math.max(0.01, durationSec);
  return `color=c=black:s=${w}x${h}:r=25:d=${d}`;
}

/**
 * Build FFmpeg CLI args for one segment render. Pure helper for tests.
 */
export function buildSegmentFfmpegArgs(segment, context, outputPath, options = {}) {
  const {
    format = "16:9",
    encodeProfile,
    dimensions,
    recipe,
    spatialIndex,
  } = options;

  const videoPath = segment.videoSourcePath;
  const audioPath = segment.audioSourcePath ?? videoPath;
  const audioOnlyVideo = !videoPath && Boolean(audioPath);

  if (!videoPath && !audioPath) {
    throw new Error(`Segment ${segment.segmentId}: brak videoSourcePath i audioSourcePath`);
  }

  const warnings = [];
  const durationSec = segmentDurationSec(segment, context);
  const audioDur = Math.max(0.01, segment.audioOutSec - segment.audioInSec);
  const videoDur = audioOnlyVideo
    ? audioDur
    : Math.max(0.01, segment.videoOutSec - segment.videoInSec);

  const desyncWarning = collectBrollDesyncWarning(segment, videoDur, audioDur);
  if (desyncWarning) {
    warnings.push(desyncWarning);
  }

  const baseVideoFilter = buildSegmentVideoFilter({
    segment,
    format,
    dimensions,
    recipe,
    spatialIndex,
    context,
  });

  const speed = resolveEffectiveSpeed(segment);
  const syncMode = segment.syncMode ?? "align_start";
  const skipVideoFitSync = speed !== 1 && syncMode === "fit_video_to_audio";
  const syncFilter = skipVideoFitSync
    ? null
    : buildVideoSyncFilter(segment, videoDur, audioDur);
  const combinedAudioFilter = buildCombinedAudioFilter(segment, videoDur, audioDur, options);
  const videoOnlyPadFilter = buildVideoOnlyPadFilter(segment, videoDur, audioDur);
  const videoFilterChain = [baseVideoFilter, syncFilter, videoOnlyPadFilter].filter(Boolean).join(",") || null;

  const isJlCutVideoOnly = isJlCutBorrowedAudio(segment);
  const isMuted = segment.audioPolicy === "mute";
  const omitEmbeddedAudio = isMuted || isJlCutVideoOnly;
  const sameSource = audioPath === videoPath;
  const useSeparateAudio = !omitEmbeddedAudio
    && (!sameSource
      || segment.audioPolicy === "from_audio_ref"
      || Math.abs(audioDur - videoDur) > 0.05);

  const wordIndex = resolveWordIndexForSegment(segment, context);
  const videoCutRangeStart = segment.videoInSec;
  const videoCutRangeEnd = segment.videoOutSec;
  const audioCutRangeStart = segment.audioInSec ?? segment.videoInSec;
  const audioCutRangeEnd = segment.audioOutSec ?? segment.videoOutSec;
  const hasAudioCuts = !omitEmbeddedAudio
    && (segment.cuts?.length ?? 0) > 0
    && wordIndex?.words?.length;

  const targetDur = durationSec;
  const args = ["-y"];

  if (audioOnlyVideo) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      buildLavfiColorInput(targetDur, dimensions),
    );
    args.push("-ss", String(segment.audioInSec ?? 0), "-i", audioPath);
  } else {
    if (segment.syncMode === "loop_video" && videoDur < audioDur) {
      const loopCount = Math.ceil(audioDur / videoDur);
      args.push("-stream_loop", String(Math.max(0, loopCount - 1)));
    }

    args.push("-ss", String(segment.videoInSec), "-i", videoPath);

    if (useSeparateAudio && audioPath) {
      args.push("-ss", String(segment.audioInSec), "-i", audioPath);
    }
  }

  if (hasAudioCuts) {
    const videoPre = videoFilterChain
      ? `[0:v]${videoFilterChain}[vcutin]`
      : "[0:v]setpts=PTS-STARTPTS[vcutin]";

    const videoCutsFilter = applyVideoCutsToRange({
      videoLabel: "[vcutin]",
      cuts: segment.cuts,
      wordIndex,
      rangeStartSec: videoCutRangeStart,
      rangeEndSec: videoCutRangeEnd,
    });

    let audioGraph = "";
    if (combinedAudioFilter) {
      const audioIn = useSeparateAudio ? "[1:a]" : "[0:a]";
      audioGraph = `${audioIn}${combinedAudioFilter}[async];`;
    }

    const audioCutsFilter = applyAudioCutsToRange({
      audioFilter: combinedAudioFilter ? "[async]" : (useSeparateAudio ? "[1:a]" : "[0:a]"),
      cuts: segment.cuts,
      wordIndex,
      rangeStartSec: audioCutRangeStart,
      rangeEndSec: audioCutRangeEnd,
      singleInput: !(useSeparateAudio && audioPath),
    });

    args.push("-filter_complex", `${videoPre};${videoCutsFilter};${audioGraph}${audioCutsFilter}`);
    args.push("-map", "[vout]", "-map", "[aout]");
    pushShortestIfNeeded(args, segment);
  } else if (videoFilterChain || combinedAudioFilter) {
    if (videoFilterChain && combinedAudioFilter && useSeparateAudio && audioPath) {
      const filterComplex = `[0:v]${videoFilterChain}[vout];[1:a]${combinedAudioFilter}[aout]`;
      args.push("-filter_complex", filterComplex);
      args.push("-map", "[vout]", "-map", "[aout]");
      pushShortestIfNeeded(args, segment);
    } else if (videoFilterChain) {
      if (isMuted || isJlCutVideoOnly) {
        args.push("-vf", videoFilterChain);
        args.push("-map", "0:v:0", "-an");
      } else if (combinedAudioFilter) {
        args.push("-vf", videoFilterChain);
        args.push("-af", combinedAudioFilter);
        if (useSeparateAudio && audioPath) {
          args.push("-map", "0:v:0", "-map", "1:a:0");
          pushShortestIfNeeded(args, segment);
        } else {
          args.push("-map", "0:v:0", "-map", "0:a:0?");
        }
      } else if (useSeparateAudio && audioPath) {
        args.push("-vf", videoFilterChain);
        args.push("-map", "0:v:0", "-map", "1:a:0");
        pushShortestIfNeeded(args, segment);
      } else {
        args.push("-vf", videoFilterChain);
        args.push("-map", "0:v:0", "-map", "0:a:0?");
      }
    } else if (combinedAudioFilter && !isMuted) {
      args.push("-af", combinedAudioFilter);
      if (useSeparateAudio && audioPath) {
        args.push("-map", "0:v:0", "-map", "1:a:0");
        pushShortestIfNeeded(args, segment);
      } else {
        args.push("-map", "0:v:0", "-map", "0:a:0?");
      }
    }
  } else if (isMuted || isJlCutVideoOnly) {
    args.push("-map", "0:v:0", "-an");
  } else if (useSeparateAudio && audioPath) {
    args.push("-map", "0:v:0", "-map", "1:a:0");
    pushShortestIfNeeded(args, segment);
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0?");
  }

  args.push("-t", String(targetDur));
  args.push(
    "-c:v", encodeProfile.videoCodec,
    "-preset", encodeProfile.preset,
    "-crf", String(encodeProfile.crf),
    "-pix_fmt", encodeProfile.pixelFormat,
  );

  if (!isMuted && !isJlCutVideoOnly) {
    args.push("-c:a", encodeProfile.audioCodec, "-b:a", encodeProfile.audioBitrate);
  }

  args.push("-movflags", "+faststart", outputPath);

  return { args, warnings, targetDur };
}

/**
 * Render one timeline segment to a temp MP4 (video + audio muxed).
 */
export async function renderSegmentToFile(segment, context, outputPath, options = {}) {
  const { args, warnings, targetDur } = buildSegmentFfmpegArgs(segment, context, outputPath, options);
  const runFfmpegFn = options.runFfmpeg ?? runFfmpeg;

  await runFfmpegFn(args, {
    label: `segment ${segment.segmentId}`,
    durationSec: targetDur,
  });

  return { outputPath, warnings };
}

export function segmentTempPath(tmpDir, index) {
  return path.join(tmpDir, `seg_${String(index).padStart(3, "0")}.mp4`);
}
