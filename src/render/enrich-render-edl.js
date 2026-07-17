import { isHookTechniqueId } from "../editorial/shorts-retention.js";

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

function resolveAudioSourcePath(segment, context) {
  const enhancedForClip = (clipId) => context.enhancedAudioPaths?.[clipId] ?? null;

  switch (segment.audioPolicy) {
    case "external":
      return context.musicBed?.trackFilePath ?? null;
    case "from_audio_ref": {
      const clipId = segment.audioRef?.clipId;
      return enhancedForClip(clipId)
        ?? (clipId ? context.clips[clipId]?.sourcePath ?? null : null);
    }
    case "mute":
      return null;
    case "from_prev":
    case "from_next":
    case "from_video_ref":
    default: {
      const clipId = segment.videoRef?.clipId ?? segment.audioRef?.clipId;
      return enhancedForClip(clipId)
        ?? (clipId ? context.clips[clipId]?.sourcePath ?? null : null);
    }
  }
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
  let segments = edl.segments.map((segment) => ({
    ...segment,
    videoSourcePath: segment.videoSourcePath ?? resolveVideoSourcePath(segment, context),
    audioSourcePath: segment.audioSourcePath ?? resolveAudioSourcePath(segment, context),
  }));

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
  attachSpatialRef,
  projectHookTitleOverlays,
  projectPatternInterruptTextOverlays,
  projectEmphasisTextOverlays,
  projectChapterCardOverlays,
  prioritizeHookWindow,
  isHookCreativeMoment,
};
