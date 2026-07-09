import path from "node:path";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { resolveSegmentOutputDuration } from "../lib/build-output-timeline.js";
import { buildSegmentVideoFilter, composeSegmentVideoFilter } from "./ffmpeg-reframe.js";
import { applyAudioCutsToRange, applyVideoCutsToRange } from "./audio-cuts.js";
import { applyAudioTimeCutsToRange, applyVideoTimeCutsToRange } from "./time-cuts.js";
import {
  buildAtempoFilterChain,
  buildSourceVolumeFilter,
  buildVideoOnlyPadFilter,
  resolveEffectiveSpeed,
  resolveSpedMediaDurations,
  shouldApplyAudioSpeed,
  shouldOmitShortestForVideoOnlySpeed,
} from "./speed-transform.js";
import {
  applyPlaybackToVideoFilter,
  shouldMutePlaybackAudio,
} from "./playback-transform.js";

export {
  applyPlaybackToVideoFilter,
  buildPlaybackVideoFilter,
  resolveBoomerangHalfSec,
  resolvePlaybackMode,
  resolvePlaybackOutputDuration,
  shouldMutePlaybackAudio,
} from "./playback-transform.js";

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

const BROLL_DESYNC_AUTO_REPAIR_THRESHOLD_SEC = 0.5;

/**
 * Auto-repair B-roll A/V desync by choosing fit_video_to_audio when syncMode unset/default.
 */
export function resolveBrollAutoSyncRepair(segment, videoDur, audioDur) {
  if ((segment.segmentRole ?? "aroll") !== "broll") {
    return null;
  }
  const syncMode = segment.syncMode ?? "align_start";
  if (syncMode !== "align_start") {
    return null;
  }
  const delta = Math.abs(videoDur - audioDur);
  if (delta <= BROLL_DESYNC_AUTO_REPAIR_THRESHOLD_SEC) {
    return null;
  }
  return {
    syncMode: "fit_video_to_audio",
    deltaSec: delta,
    code: "broll_av_desync_repaired",
    message:
      `B-roll ${segment.segmentId}: auto fit_video_to_audio (Δ=${delta.toFixed(2)}s)`,
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
  const { spedVideoDur, spedAudioDur } = resolveSpedMediaDurations(segment, videoDur, audioDur);

  const audioSpeedFilter = applyAudioSpeed ? buildAtempoFilterChain(speed) : null;
  const audioSyncFilter = buildAudioSyncFilter(segment, spedVideoDur, spedAudioDur, options);
  const audioVolumeFilter = buildSourceVolumeFilter(segment.sourceVolumeDb);

  const parts = [audioSpeedFilter, audioSyncFilter, audioVolumeFilter].filter(Boolean);
  return parts.length > 0 ? parts.join(",") : null;
}

function pipOverlayPosition(position, marginPx, dimensions) {
  const w = dimensions?.width ?? 1920;
  const h = dimensions?.height ?? 1080;
  switch (position) {
    case "top_left":
      return { x: marginPx, y: marginPx };
    case "bottom_left":
      return { x: marginPx, y: `main_h-overlay_h-${marginPx}` };
    case "bottom_right":
      return { x: `main_w-overlay_w-${marginPx}`, y: `main_h-overlay_h-${marginPx}` };
    case "top_right":
    default:
      return { x: `main_w-overlay_w-${marginPx}`, y: marginPx };
  }
}

/**
 * Build PiP overlay filter fragment (second input [1:v] over main [0:v]).
 */
export function buildPictureInPictureFilter(segment, dimensions = {}) {
  const pip = segment.pictureInPicture;
  if (!pip?.enabled) {
    return null;
  }
  const scale = Math.min(0.5, Math.max(0.1, pip.scale ?? 0.28));
  const marginPx = pip.marginPx ?? 24;
  const { x, y } = pipOverlayPosition(pip.position ?? "bottom_right", marginPx, dimensions);
  const w = dimensions.width ?? 1920;
  const h = dimensions.height ?? 1080;
  const pipW = Math.round(w * scale);
  const pipH = Math.round(h * scale);
  return `[1:v]scale=${pipW}:${pipH}[pip];[0:v][pip]overlay=${x}:${y}[vout]`;
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

  const autoRepair = resolveBrollAutoSyncRepair(segment, videoDur, audioDur);
  const effectiveSegment = autoRepair
    ? { ...segment, syncMode: autoRepair.syncMode }
    : segment;

  if (autoRepair) {
    warnings.push({
      code: autoRepair.code,
      segmentId: segment.segmentId,
      message: autoRepair.message,
      deltaSec: autoRepair.deltaSec,
    });
  } else {
    const desyncWarning = collectBrollDesyncWarning(segment, videoDur, audioDur);
    if (desyncWarning) {
      warnings.push(desyncWarning);
    }
  }

  const baseVideoFilter = buildSegmentVideoFilter({
    segment: effectiveSegment,
    format,
    dimensions,
    recipe,
    spatialIndex,
    context,
  });

  const { spedVideoDur, spedAudioDur } = resolveSpedMediaDurations(
    effectiveSegment,
    videoDur,
    audioDur,
  );
  const syncFilter = buildVideoSyncFilter(effectiveSegment, spedVideoDur, spedAudioDur);
  const combinedAudioFilter = buildCombinedAudioFilter(effectiveSegment, videoDur, audioDur, options);
  const videoOnlyPadFilter = buildVideoOnlyPadFilter(effectiveSegment, videoDur, audioDur);
  let videoFilter = composeSegmentVideoFilter(
    baseVideoFilter,
    [syncFilter, videoOnlyPadFilter],
  );
  videoFilter = applyPlaybackToVideoFilter(videoFilter, effectiveSegment, spedVideoDur);

  const isJlCutVideoOnly = isJlCutBorrowedAudio(segment);
  const isMuted = segment.audioPolicy === "mute" || shouldMutePlaybackAudio(effectiveSegment);
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
    && (effectiveSegment.cuts?.length ?? 0) > 0
    && wordIndex?.words?.length;
  const hasTimeCuts = (effectiveSegment.timeCuts?.length ?? 0) > 0;
  const pipFilter = buildPictureInPictureFilter(effectiveSegment, dimensions);
  const pipScenePath = pipFilter && effectiveSegment.pictureInPicture?.sceneId
    ? context?.sceneSources?.[effectiveSegment.pictureInPicture.sceneId]
    : null;
  const outputStartSec = effectiveSegment.outputStartSec ?? 0;
  const outputEndSec = effectiveSegment.outputEndSec ?? outputStartSec + durationSec;

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

    if (pipScenePath) {
      args.push("-ss", "0", "-i", pipScenePath);
    }

    if (useSeparateAudio && audioPath) {
      args.push("-ss", String(segment.audioInSec), "-i", audioPath);
    }
  }

  if (hasAudioCuts || hasTimeCuts) {
    const videoPre = videoFilter
      ? (videoFilter.mode === "filter_complex"
        ? `${videoFilter.graph}[vcutin]`
        : `[0:v]${videoFilter.chain}[vcutin]`)
      : "[0:v]setpts=PTS-STARTPTS[vcutin]";

    let videoCutsFilter;
    if (hasAudioCuts) {
      videoCutsFilter = applyVideoCutsToRange({
        videoLabel: "[vcutin]",
        cuts: effectiveSegment.cuts,
        wordIndex,
        rangeStartSec: videoCutRangeStart,
        rangeEndSec: videoCutRangeEnd,
      });
    }
    if (hasTimeCuts) {
      videoCutsFilter = applyVideoTimeCutsToRange({
        videoLabel: hasAudioCuts ? "[vout]" : "[vcutin]",
        timeCuts: effectiveSegment.timeCuts,
        rangeStartSec: outputStartSec,
        rangeEndSec: outputEndSec,
      });
    }

    const audioInputLabel = useSeparateAudio && audioPath
      ? `[${pipScenePath ? 2 : 1}:a]`
      : "[0:a]";

    let audioGraph = "";
    if (combinedAudioFilter) {
      audioGraph = `${audioInputLabel}${combinedAudioFilter}[async];`;
    }

    let audioCutsFilter;
    if (hasAudioCuts) {
      audioCutsFilter = applyAudioCutsToRange({
        audioFilter: combinedAudioFilter ? "[async]" : audioInputLabel,
        cuts: effectiveSegment.cuts,
        wordIndex,
        rangeStartSec: audioCutRangeStart,
        rangeEndSec: audioCutRangeEnd,
        singleInput: !(useSeparateAudio && audioPath),
      });
    } else {
      audioCutsFilter = applyAudioTimeCutsToRange({
        audioFilter: combinedAudioFilter ? "[async]" : audioInputLabel,
        timeCuts: effectiveSegment.timeCuts,
        rangeStartSec: outputStartSec,
        rangeEndSec: outputEndSec,
        singleInput: !(useSeparateAudio && audioPath),
      });
    }

    let filterTail = `${videoPre};${videoCutsFilter};${audioGraph}${audioCutsFilter}`;
    if (pipFilter && pipScenePath) {
      filterTail = `${filterTail};[vout][1:v]${pipFilter.replace(/^\[1:v\]/, "").replace(/\[0:v\]/, "[vout]")}`;
    }

    args.push("-filter_complex", filterTail);
    args.push("-map", "[vout]", "-map", "[aout]");
    pushShortestIfNeeded(args, effectiveSegment);
  } else if (videoFilter || combinedAudioFilter || (pipFilter && pipScenePath)) {
    if (videoFilter && combinedAudioFilter && useSeparateAudio && audioPath) {
      const videoOut = videoFilter.mode === "filter_complex"
        ? `${videoFilter.graph}[vout]`
        : `[0:v]${videoFilter.chain}[vout]`;
      const filterComplex = `${videoOut};[1:a]${combinedAudioFilter}[aout]`;
      args.push("-filter_complex", filterComplex);
      args.push("-map", "[vout]", "-map", "[aout]");
      pushShortestIfNeeded(args, segment);
    } else if (videoFilter) {
      if (isMuted || isJlCutVideoOnly) {
        if (videoFilter.mode === "filter_complex") {
          args.push("-filter_complex", `${videoFilter.graph}[vout]`);
          args.push("-map", "[vout]", "-an");
        } else {
          args.push("-vf", videoFilter.chain);
          args.push("-map", "0:v:0", "-an");
        }
      } else if (combinedAudioFilter) {
        if (videoFilter.mode === "filter_complex") {
          args.push("-filter_complex", `${videoFilter.graph}[vout]`);
          args.push("-map", "[vout]");
        } else {
          args.push("-vf", videoFilter.chain);
          args.push("-map", "0:v:0");
        }
        args.push("-af", combinedAudioFilter);
        if (useSeparateAudio && audioPath) {
          args.push("-map", "1:a:0");
          pushShortestIfNeeded(args, segment);
        } else {
          args.push("-map", "0:a:0?");
        }
      } else if (useSeparateAudio && audioPath) {
        if (videoFilter.mode === "filter_complex") {
          args.push("-filter_complex", `${videoFilter.graph}[vout]`);
          args.push("-map", "[vout]", "-map", "1:a:0");
        } else {
          args.push("-vf", videoFilter.chain);
          args.push("-map", "0:v:0", "-map", "1:a:0");
        }
        pushShortestIfNeeded(args, segment);
      } else if (videoFilter.mode === "filter_complex") {
        args.push("-filter_complex", `${videoFilter.graph}[vout]`);
        args.push("-map", "[vout]", "-map", "0:a:0?");
      } else {
        args.push("-vf", videoFilter.chain);
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
