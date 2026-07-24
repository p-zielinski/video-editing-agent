import { isHookTechniqueId } from "../editorial/shorts-retention.js";
import { buildSpeechAmbientSourcePlan } from "./audio-source-duck.js";

function resolveVideoSourcePath(segment, context) {
  const clipId = segment.videoRef?.clipId;
  if (!clipId) {
    return null;
  }
  const clip = context.clips[clipId];
  if (!clip) {
    return null;
  }
  if (clip.mediaType === "audio_only") {
    return null;
  }
  return clip.sourcePath ?? null;
}

function resolveClipOriginalPath(clipId, context) {
  return clipId ? context.clips[clipId]?.sourcePath ?? null : null;
}

/**
 * Original camera/source audio path (never enhanced WAV).
 */
function resolveOriginalAudioSourcePath(segment, context) {
  switch (segment.audioPolicy) {
    case "external":
      return context.musicBed?.trackFilePath ?? null;
    case "from_audio_ref":
      return resolveClipOriginalPath(segment.audioRef?.clipId, context);
    case "mute":
      return null;
    case "from_prev":
    case "from_next":
    case "from_video_ref":
    default:
      return resolveClipOriginalPath(
        segment.videoRef?.clipId ?? segment.audioRef?.clipId,
        context,
      );
  }
}

function resolveEnhancedAudioSourcePath(segment, context) {
  if (segment.preserveAmbientAudio === true) {
    return null;
  }
  if (segment.audioPolicy === "external" || segment.audioPolicy === "mute") {
    return null;
  }
  const clipId = segment.audioPolicy === "from_audio_ref"
    ? segment.audioRef?.clipId
    : (segment.videoRef?.clipId ?? segment.audioRef?.clipId);
  return clipId ? context.enhancedAudioPaths?.[clipId] ?? null : null;
}

function resolveAudioSourcePath(segment, context) {
  // Intentional ambient showcase: never substitute denoised WAV for this segment.
  const enhanced = resolveEnhancedAudioSourcePath(segment, context);
  const original = resolveOriginalAudioSourcePath(segment, context);
  return enhanced ?? original;
}

function resolveWordsForSegment(segment, context) {
  const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
  if (!clipId) {
    return null;
  }
  return context.wordIndexes?.[clipId]?.words
    ?? segment.wordIndex?.words
    ?? null;
}

/**
 * Attach speech↔ambient source-duck plan when both original + enhanced exist.
 */
export function resolveAudioSourceDuckFields(segment, context) {
  if (segment.audioPolicy === "external" || segment.audioPolicy === "mute") {
    return {};
  }

  const originalPath = resolveOriginalAudioSourcePath(segment, context);
  const enhancedPath = resolveEnhancedAudioSourcePath(segment, context);
  const plan = buildSpeechAmbientSourcePlan(
    segment,
    resolveWordsForSegment(segment, context),
    enhancedPath,
    originalPath,
  );

  if (plan.mode !== "speech_ambient_duck") {
    return {};
  }

  return {
    audioSourceDuck: plan,
    audioSourceOriginalPath: plan.originalPath,
    audioSourceEnhancedPath: plan.enhancedPath,
  };
}

/**
 * Classify resolved audio path as original | enhanced | speech_ambient_duck.
 * @returns {"original"|"enhanced"|"speech_ambient_duck"|null}
 */
export function resolveAudioSourceKind(segment, context, audioSourcePath = null) {
  if (segment.audioSourceDuck?.mode === "speech_ambient_duck") {
    return "speech_ambient_duck";
  }
  const resolvedPath = audioSourcePath ?? resolveAudioSourcePath(segment, context);
  if (!resolvedPath) {
    return null;
  }
  const clipIds = [
    segment.audioRef?.clipId,
    segment.videoRef?.clipId,
  ].filter(Boolean);
  for (const clipId of clipIds) {
    const enhanced = context.enhancedAudioPaths?.[clipId];
    if (enhanced && enhanced === resolvedPath) {
      return "enhanced";
    }
  }
  return "original";
}

function findSpatialAnchor(spatialIndex, sceneId) {
  const scene = spatialIndex?.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene?.anchors?.length) {
    return scene?.primaryAnchor ?? null;
  }
  return scene.primaryAnchor ?? scene.anchors[0];
}

function attachSpatialRef(segment, spatialIndex, format) {
  const sceneId = segment.videoRef?.sceneId;
  if (!sceneId || !spatialIndex) {
    return segment;
  }

  const needsSpatial = format === "9:16"
    || segment.videoTransform?.reframe === "face"
    || segment.videoTransform?.reframe === "subject"
    || segment.spatialRef;

  if (!needsSpatial) {
    return segment;
  }

  const anchor = findSpatialAnchor(spatialIndex, sceneId);
  if (!anchor && !segment.spatialRef) {
    return segment;
  }

  return {
    ...segment,
    spatialRef: segment.spatialRef ?? {
      clipId: segment.videoRef?.clipId,
      sceneId,
      anchorType: anchor?.type ?? anchor?.anchorType,
      bbox: anchor?.bbox,
    },
  };
}

function findSegmentForMoment(segments, outputStartSec) {
  return segments.find(
    (seg) => outputStartSec >= seg.outputStartSec && outputStartSec < seg.outputEndSec,
  ) ?? segments[0];
}

function hasHookOverlayInWindow(overlays, startSec, endSec) {
  return overlays.some(
    (o) => (o.role === "hook" || o.style?.startsWith("hook_"))
      && o.outputStartSec < endSec
      && o.outputEndSec > startSec,
  );
}

function hasOverlayInWindow(overlays, startSec, endSec, { role, text } = {}) {
  return overlays.some(
    (o) => o.outputStartSec < endSec
      && o.outputEndSec > startSec
      && (role == null || o.role === role)
      && (text == null || o.text === text),
  );
}

function projectHookTitleOverlays(segments, creativeMoments, outputId) {
  const hookMoments = (creativeMoments ?? []).filter(
    (m) => m.outputId === outputId && m.techniqueId === "hook_title_overlay",
  );

  if (hookMoments.length === 0) {
    return segments;
  }

  return segments.map((seg) => {
    const overlays = [...(seg.textOverlays ?? [])];

    for (const moment of hookMoments) {
      const targetSeg = findSegmentForMoment(segments, moment.outputStartSec);
      if (targetSeg?.segmentId !== seg.segmentId) {
        continue;
      }

      if (hasHookOverlayInWindow(overlays, moment.outputStartSec, moment.outputEndSec)) {
        continue;
      }

      const style = moment.params?.style ?? "hook_large";
      const positionMap = {
        top: "top_center",
        bottom_third: "bottom_center",
        center: "center",
      };

      overlays.push({
        text: moment.params?.text ?? moment.reason,
        outputStartSec: moment.outputStartSec,
        outputEndSec: moment.outputEndSec,
        style,
        role: "hook",
        position: positionMap[moment.params?.position] ?? "center",
      });
    }

    return { ...seg, textOverlays: overlays };
  });
}

function projectEmphasisTextOverlays(segments, creativeMoments, outputId) {
  const emphasisMoments = (creativeMoments ?? []).filter(
    (m) => m.outputId === outputId && m.techniqueId === "emphasis_text",
  );

  if (emphasisMoments.length === 0) {
    return segments;
  }

  const positionMap = {
    top: "top_center",
    bottom_third: "bottom_center",
    center: "center",
  };

  return segments.map((seg) => {
    const overlays = [...(seg.textOverlays ?? [])];

    for (const moment of emphasisMoments) {
      const targetSeg = findSegmentForMoment(segments, moment.outputStartSec);
      if (targetSeg?.segmentId !== seg.segmentId) {
        continue;
      }

      const text = moment.params?.text ?? moment.reason;
      if (!text) {
        continue;
      }

      if (hasOverlayInWindow(overlays, moment.outputStartSec, moment.outputEndSec, { text })) {
        continue;
      }

      overlays.push({
        text,
        outputStartSec: moment.outputStartSec,
        outputEndSec: moment.outputEndSec,
        style: moment.params?.style ?? "emphasis",
        role: "beat",
        position: positionMap[moment.params?.position] ?? "bottom_center",
      });
    }

    return { ...seg, textOverlays: overlays };
  });
}

function projectPatternInterruptTextOverlays(segments, creativeMoments, outputId) {
  const textMoments = (creativeMoments ?? []).filter(
    (m) => m.outputId === outputId
      && m.techniqueId === "pattern_interrupt"
      && (m.params?.mode ?? "cut_zoom") === "cut_text",
  );

  if (textMoments.length === 0) {
    return segments;
  }

  const positionMap = {
    top: "top_center",
    bottom_third: "bottom_center",
    center: "center",
  };

  return segments.map((seg) => {
    const overlays = [...(seg.textOverlays ?? [])];

    for (const moment of textMoments) {
      const targetSeg = findSegmentForMoment(segments, moment.outputStartSec);
      if (targetSeg?.segmentId !== seg.segmentId) {
        continue;
      }

      const text = moment.params?.text ?? moment.reason;
      if (!text) {
        continue;
      }

      if (hasOverlayInWindow(overlays, moment.outputStartSec, moment.outputEndSec, { text })) {
        continue;
      }

      overlays.push({
        text,
        outputStartSec: moment.outputStartSec,
        outputEndSec: moment.outputEndSec,
        style: moment.params?.style ?? "emphasis",
        role: "beat",
        position: positionMap[moment.params?.position] ?? "center",
      });
    }

    return { ...seg, textOverlays: overlays };
  });
}

function projectChapterCardOverlays(segments, creativeMoments, outputId) {
  const chapterMoments = (creativeMoments ?? []).filter(
    (m) => m.outputId === outputId && m.techniqueId === "chapter_card",
  );

  if (chapterMoments.length === 0) {
    return segments;
  }

  return segments.map((seg) => {
    const overlays = [...(seg.textOverlays ?? [])];

    for (const moment of chapterMoments) {
      const targetSeg = findSegmentForMoment(segments, moment.outputStartSec);
      if (targetSeg?.segmentId !== seg.segmentId) {
        continue;
      }

      const text = moment.params?.label ?? moment.params?.text ?? moment.reason;
      if (!text) {
        continue;
      }

      if (hasOverlayInWindow(overlays, moment.outputStartSec, moment.outputEndSec, { text })) {
        continue;
      }

      overlays.push({
        text,
        outputStartSec: moment.outputStartSec,
        outputEndSec: moment.outputEndSec,
        style: "chapter_card",
        role: "chapter",
        position: "center",
      });
    }

    return { ...seg, textOverlays: overlays };
  });
}

function prioritizeHookWindow(segments, hookWindowSec) {
  if (!hookWindowSec || hookWindowSec <= 0) {
    return segments;
  }

  return segments.map((seg) => {
    const overlays = (seg.textOverlays ?? []).map((overlay) => {
      const isHook = overlay.role === "hook" || overlay.style?.startsWith("hook_");
      if (!isHook) {
        return overlay;
      }

      const duration = overlay.outputEndSec - overlay.outputStartSec;
      const start = Math.min(overlay.outputStartSec, hookWindowSec - 0.1);
      const clampedStart = Math.max(0, Math.min(start, hookWindowSec - 0.1));
      const clampedEnd = Math.min(
        overlay.outputEndSec,
        clampedStart + duration,
        hookWindowSec,
      );

      return {
        ...overlay,
        outputStartSec: clampedStart,
        outputEndSec: Math.max(clampedStart + 0.1, clampedEnd),
      };
    });

    return { ...seg, textOverlays: overlays };
  });
}

function isHookCreativeMoment(moment) {
  return moment.retentionRole === "hook" || isHookTechniqueId(moment.techniqueId);
}

/**
 * Clamp hook-related creativeMoments to [0, hookWindowSec] on short outputs.
 */
export function clampCreativeMomentsToHookWindow(moments, hookWindowSec) {
  if (!hookWindowSec || hookWindowSec <= 0) {
    return moments;
  }

  return (moments ?? []).map((moment) => {
    if (!isHookCreativeMoment(moment)) {
      return moment;
    }

    const duration = moment.outputEndSec - moment.outputStartSec;
    const start = Math.min(moment.outputStartSec, hookWindowSec - 0.1);
    const clampedStart = Math.max(0, Math.min(start, hookWindowSec - 0.1));
    const clampedEnd = Math.min(
      moment.outputEndSec,
      clampedStart + duration,
      hookWindowSec,
    );

    return {
      ...moment,
      outputStartSec: clampedStart,
      outputEndSec: Math.max(clampedStart + 0.1, clampedEnd),
    };
  });
}

/**
 * Enrich a render EDL with resolved paths, spatial refs, and projected overlays.
 */
export function enrichRenderEdl(edl, { recipe, context, output, spatialIndex }) {
  let segments = edl.segments.map((segment) => {
    const duckFields = segment.audioSourceDuck
      ? {}
      : resolveAudioSourceDuckFields(segment, context);
    const audioSourcePath = segment.audioSourcePath ?? resolveAudioSourcePath(segment, context);
    const enriched = {
      ...segment,
      ...duckFields,
      videoSourcePath: segment.videoSourcePath ?? resolveVideoSourcePath(segment, context),
      audioSourcePath,
    };
    return {
      ...enriched,
      audioSource: segment.audioSource
        ?? resolveAudioSourceKind(enriched, context, audioSourcePath),
    };
  });

  segments = segments.map((seg) => attachSpatialRef(seg, spatialIndex, edl.format));

  let creativeMoments = (recipe?.creativeMoments ?? []).filter(
    (m) => m.outputId === edl.outputId,
  );

  segments = projectHookTitleOverlays(
    segments,
    creativeMoments,
    edl.outputId,
  );

  segments = projectPatternInterruptTextOverlays(
    segments,
    creativeMoments,
    edl.outputId,
  );

  segments = projectEmphasisTextOverlays(
    segments,
    creativeMoments,
    edl.outputId,
  );

  segments = projectChapterCardOverlays(
    segments,
    creativeMoments,
    edl.outputId,
  );

  const retention = recipe?.shortsRetentionProfile;
  const isShort = output?.outputKind === "short" || edl.outputKind === "short";
  if (retention?.enabled && isShort) {
    const hookWindowSec = retention.hookWindowSec ?? 3;
    segments = prioritizeHookWindow(segments, hookWindowSec);
    creativeMoments = clampCreativeMomentsToHookWindow(creativeMoments, hookWindowSec);
  }

  return { ...edl, segments, creativeMoments };
}

export {
  resolveVideoSourcePath,
  resolveAudioSourcePath,
  resolveOriginalAudioSourcePath,
  resolveEnhancedAudioSourcePath,
  attachSpatialRef,
  projectHookTitleOverlays,
  projectPatternInterruptTextOverlays,
  projectEmphasisTextOverlays,
  projectChapterCardOverlays,
  prioritizeHookWindow,
  isHookCreativeMoment,
};
