const DEFAULT_SEGMENT_SEC = 5;
const MIN_SEGMENT_SEC = 3;

function normalizeLabel(value) {
  return String(value ?? "").toLowerCase().trim();
}

function labelsOverlap(a, b) {
  const left = normalizeLabel(a);
  const right = normalizeLabel(b);
  if (!left || !right) {
    return false;
  }
  return left.includes(right) || right.includes(left);
}

function roundSec(value) {
  return Math.round(value * 100) / 100;
}

function speechDurationSec(topic) {
  const range = topic.timeRange;
  if (!range || range.endSec == null || range.startSec == null) {
    return DEFAULT_SEGMENT_SEC;
  }
  return Math.max(MIN_SEGMENT_SEC, range.endSec - range.startSec);
}

function sceneDurationSec(scene) {
  if (scene.durationSec != null) {
    return scene.durationSec;
  }
  return Math.max(0, (scene.endSec ?? 0) - (scene.startSec ?? 0));
}

function findBestKeyMomentIndex(keyMoments, topicLabel) {
  const index = keyMoments.findIndex((moment) => labelsOverlap(moment, topicLabel));
  return index >= 0 ? index : 0;
}

function targetTimestampFromKeyMoments(scene, keyMoments, topicLabel) {
  const duration = sceneDurationSec(scene);
  if (keyMoments.length === 0 || duration <= 0) {
    return scene.startSec ?? 0;
  }

  const momentIndex = findBestKeyMomentIndex(keyMoments, topicLabel);
  const fraction = (momentIndex + 0.5) / keyMoments.length;
  return (scene.startSec ?? 0) + duration * fraction * 0.85;
}

function pickBestKeyframe(keyframes, topic, l1) {
  const keyMoments = l1.keyMoments ?? [];
  if (keyMoments.length === 0) {
    return keyframes[0];
  }

  const targetSec = targetTimestampFromKeyMoments(
    { startSec: keyframes[0].timestampSec, durationSec: keyframes.at(-1).timestampSec - keyframes[0].timestampSec },
    keyMoments,
    topic.label,
  );

  return keyframes.reduce((best, frame) => {
    const bestDist = Math.abs(best.timestampSec - targetSec);
    const frameDist = Math.abs(frame.timestampSec - targetSec);
    return frameDist < bestDist ? frame : best;
  });
}

/**
 * Groups keyframes from timeline index or per-clip artifacts by clipId.
 * @param {object} timelineIndex
 * @param {object[] | null} keyframeArtifacts — optional `02-keyframes-*.json` payloads
 */
export function buildKeyframesByClip(timelineIndex, keyframeArtifacts = null) {
  if (keyframeArtifacts?.length) {
    const byClip = {};
    for (const artifact of keyframeArtifacts) {
      byClip[artifact.clipId] = artifact.keyframes ?? [];
    }
    return byClip;
  }

  const sceneClipIds = new Map(
    (timelineIndex.scenes ?? []).map((scene) => [scene.sceneId, scene.clipId]),
  );
  const byClip = {};

  for (const frame of timelineIndex.keyframes ?? []) {
    const clipId = sceneClipIds.get(frame.sceneId) ?? frame.sceneId.split("_")[0];
    if (!byClip[clipId]) {
      byClip[clipId] = [];
    }
    byClip[clipId].push(frame);
  }

  return byClip;
}

/**
 * Suggests B-roll videoIn/videoOut per topic matching scene from keyframes or L1 keyMoments.
 * @returns {Array<{ topicId, sceneId, suggestedVideoInSec, suggestedVideoOutSec, confidence, reason }>}
 */
export function buildBrollSyncHints({
  topicIndex,
  timelineIndex,
  keyframesByClip,
  abstractL1 = [],
}) {
  const hints = [];
  const scenesById = new Map((timelineIndex.scenes ?? []).map((scene) => [scene.sceneId, scene]));
  const l1ByScene = new Map((abstractL1 ?? []).map((entry) => [entry.sceneId, entry]));

  for (const topic of topicIndex?.topics ?? []) {
    for (const match of topic.matchingScenes ?? []) {
      const scene = scenesById.get(match.sceneId);
      if (!scene) {
        continue;
      }

      const clipId = scene.clipId;
      const sceneKeyframes = (keyframesByClip?.[clipId] ?? [])
        .filter((frame) => frame.sceneId === match.sceneId)
        .sort((a, b) => a.timestampSec - b.timestampSec);
      const l1 = l1ByScene.get(match.sceneId) ?? {};
      const segmentDur = speechDurationSec(topic);
      const matchScore = match.score ?? 0.5;

      let suggestedVideoInSec;
      let suggestedVideoOutSec;
      let confidence;
      let reason;

      if (sceneKeyframes.length > 0) {
        const bestFrame = pickBestKeyframe(sceneKeyframes, topic, l1);
        suggestedVideoInSec = bestFrame.timestampSec;
        suggestedVideoOutSec = Math.min(scene.endSec, suggestedVideoInSec + segmentDur);
        confidence = matchScore * (bestFrame.trigger === "speech" ? 0.95 : 0.85);
        reason = `keyframes:${bestFrame.trigger}`;
      } else if ((l1.keyMoments ?? []).length > 0) {
        const momentIndex = findBestKeyMomentIndex(l1.keyMoments, topic.label);
        suggestedVideoInSec = targetTimestampFromKeyMoments(scene, l1.keyMoments, topic.label);
        suggestedVideoOutSec = Math.min(scene.endSec, suggestedVideoInSec + segmentDur);
        confidence = matchScore * 0.65;
        reason = `l1_keyMoment:${l1.keyMoments[momentIndex]}`;
      } else {
        suggestedVideoInSec = scene.startSec ?? 0;
        suggestedVideoOutSec = Math.min(scene.endSec ?? suggestedVideoInSec + segmentDur, suggestedVideoInSec + segmentDur);
        confidence = matchScore * 0.5;
        reason = "scene_start_fallback";
      }

      if (suggestedVideoOutSec <= suggestedVideoInSec) {
        suggestedVideoOutSec = Math.min(scene.endSec ?? suggestedVideoInSec + MIN_SEGMENT_SEC, suggestedVideoInSec + MIN_SEGMENT_SEC);
      }

      hints.push({
        topicId: topic.topicId,
        sceneId: match.sceneId,
        suggestedVideoInSec: roundSec(suggestedVideoInSec),
        suggestedVideoOutSec: roundSec(suggestedVideoOutSec),
        confidence: roundSec(confidence),
        reason,
      });
    }
  }

  return hints.sort((a, b) => b.confidence - a.confidence);
}
