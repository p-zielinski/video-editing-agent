export function resolveEffectiveSpeed(segment) {
  return segment.videoTransform?.speed ?? 1;
}

export function adjustDurationForSpeed(durationSec, speed) {
  if (speed === 1) {
    return durationSec;
  }
  return durationSec / speed;
}

/**
 * Output durations after speed transform (video always; audio when atempo applies).
 */
export function resolveSpedMediaDurations(segment, videoDur, audioDur) {
  const speed = resolveEffectiveSpeed(segment);
  if (speed === 1) {
    return { spedVideoDur: videoDur, spedAudioDur: audioDur };
  }

  const spedVideoDur = adjustDurationForSpeed(videoDur, speed);
  const spedAudioDur = shouldApplyAudioSpeed(segment, speed)
    ? adjustDurationForSpeed(audioDur, speed)
    : audioDur;

  return { spedVideoDur, spedAudioDur };
}

export function buildAtempoFilterChain(speed) {
  if (speed === 1) {
    return null;
  }

  const filters = [];
  let remaining = speed;

  if (speed > 1) {
    while (remaining > 2.0 + 1e-9) {
      filters.push("atempo=2.0");
      remaining /= 2.0;
    }
    if (Math.abs(remaining - 1) > 1e-9) {
      filters.push(`atempo=${remaining}`);
    }
  } else {
    while (remaining < 0.5 - 1e-9) {
      filters.push("atempo=0.5");
      remaining /= 0.5;
    }
    if (Math.abs(remaining - 1) > 1e-9) {
      filters.push(`atempo=${remaining}`);
    }
  }

  return filters.length > 0 ? filters.join(",") : null;
}

export function shouldApplyAudioSpeed(segment, speed) {
  if (speed === 1) {
    return false;
  }
  const speedMode = segment.videoTransform?.speedMode ?? "video_audio";
  if (speedMode === "video_only") {
    return false;
  }
  const policy = segment.audioPolicy;
  return policy === "from_video_ref" || policy === "from_audio_ref";
}

export function buildSourceVolumeFilter(sourceVolumeDb) {
  if (sourceVolumeDb == null || sourceVolumeDb === 0) {
    return null;
  }
  const linear = 10 ** (sourceVolumeDb / 20);
  return `volume=${linear}`;
}

export function buildVideoOnlyPadFilter(segment, videoDur, audioDur) {
  const speed = resolveEffectiveSpeed(segment);
  if (speed === 1) {
    return null;
  }
  const speedMode = segment.videoTransform?.speedMode ?? "video_audio";
  if (speedMode !== "video_only") {
    return null;
  }
  if (segment.audioPolicy === "from_prev" || segment.audioPolicy === "from_next" || segment.audioPolicy === "mute") {
    return null;
  }

  const spedVideo = adjustDurationForSpeed(videoDur, speed);
  if (spedVideo >= audioDur - 0.01) {
    return null;
  }

  const padSec = audioDur - spedVideo;
  return `tpad=stop_mode=clone:stop_duration=${padSec}`;
}

export function shouldOmitShortestForVideoOnlySpeed(segment) {
  const speed = resolveEffectiveSpeed(segment);
  if (speed === 1) {
    return false;
  }
  const speedMode = segment.videoTransform?.speedMode ?? "video_audio";
  return speedMode === "video_only";
}
