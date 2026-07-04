import { buildDaySegments } from "../lib/abstraction-chunking.js";
import { buildOutputTimeline } from "../lib/build-output-timeline.js";

export const COLD_OPEN_SEGMENT_ID = "enrich_cold_open_01";
export const REWIND_INTRO_SEGMENT_ID = "enrich_rewind_intro_01";

function clipSortIndex(clipRegistry, clipId) {
  return clipRegistry.find((clip) => clip.clipId === clipId)?.sortIndex ?? Number.MAX_SAFE_INTEGER;
}

function clipDayIndex(daySegments, clipId) {
  return daySegments.findIndex((day) => day.clipIds.includes(clipId));
}

function collectArollClipPassOrder(timeline) {
  const seen = new Set();
  const order = [];

  for (const segment of timeline) {
    if (segment.segmentRole === "broll" && segment.audioPolicy === "from_audio_ref") {
      continue;
    }
    const clipId = segment.videoRef?.clipId;
    if (!clipId || seen.has(clipId)) {
      continue;
    }
    seen.add(clipId);
    order.push(clipId);
  }

  return order;
}

function isColdOpenExemptSegment(segment, index, teaseSceneId) {
  if (index === 0 && segment.segmentId === COLD_OPEN_SEGMENT_ID) {
    return true;
  }
  if (index === 0 && teaseSceneId && segment.videoRef?.sceneId === teaseSceneId) {
    return true;
  }
  return false;
}

/**
 * Validates main timeline chronology for multi_clip_day batches.
 */
export function validateMultiClipChronology(recipe, { teaseSceneId = null } = {}) {
  const issues = [];
  if (recipe.batchContext?.inputMode !== "multi_clip_day") {
    return issues;
  }

  const clipRegistry = recipe.clipRegistry ?? [];
  if (clipRegistry.length < 2) {
    return issues;
  }

  const main = recipe.outputs?.find((output) => output.outputKind === "main");
  if (!main?.timeline?.length) {
    return issues;
  }

  const enriched = buildOutputTimeline(main);
  let maxSortSeen = -1;

  for (let index = 0; index < enriched.length; index += 1) {
    const segment = enriched[index];
    if (segment.segmentRole !== "aroll") {
      continue;
    }
    if (isColdOpenExemptSegment(segment, index, teaseSceneId)) {
      continue;
    }
    if (segment.segmentId === REWIND_INTRO_SEGMENT_ID) {
      continue;
    }

    const sortIdx = clipSortIndex(clipRegistry, segment.videoRef?.clipId);
    if (sortIdx < maxSortSeen) {
      issues.push({
        severity: "error",
        code: "V25-CHR-01",
        message: `Main timeline: klip ${segment.videoRef?.clipId} (sortIndex ${sortIdx}) przed wcześniejszym klipem (max ${maxSortSeen})`,
        outputId: main.outputId,
        sceneId: segment.videoRef?.sceneId,
      });
      break;
    }
    maxSortSeen = Math.max(maxSortSeen, sortIdx);
  }

  const daySegments = buildDaySegments(clipRegistry);
  if (daySegments.length >= 2) {
    let maxDayIdx = -1;
    for (let index = 0; index < enriched.length; index += 1) {
      const segment = enriched[index];
      if (segment.segmentRole !== "aroll") {
        continue;
      }
      if (isColdOpenExemptSegment(segment, index, teaseSceneId)) {
        continue;
      }

      const dayIdx = clipDayIndex(daySegments, segment.videoRef?.clipId);
      if (dayIdx < 0) {
        continue;
      }
      if (dayIdx < maxDayIdx) {
        issues.push({
          severity: "error",
          code: "V25-CHR-02",
          message: `Main timeline: klip z ${daySegments[dayIdx].date} po klipach z ${daySegments[maxDayIdx].date}`,
          outputId: main.outputId,
          sceneId: segment.videoRef?.sceneId,
        });
        break;
      }
      maxDayIdx = Math.max(maxDayIdx, dayIdx);
    }
  }

  const hasColdOpenTease = enriched.some((segment) => segment.segmentId === COLD_OPEN_SEGMENT_ID)
    || (teaseSceneId && enriched[0]?.videoRef?.sceneId === teaseSceneId);
  if (hasColdOpenTease) {
    const rewindIdx = enriched.findIndex(
      (segment) => segment.segmentId === REWIND_INTRO_SEGMENT_ID
        || segment.segmentId === "enrich_rewind_intro_01",
    );
    if (rewindIdx < 0 || rewindIdx > 2) {
      issues.push({
        severity: "error",
        code: "V25-CHR-03",
        message: "Cold open bez rewind do chronologicznego intro w pierwszych segmentach",
        outputId: main.outputId,
      });
    }
  }

  return issues;
}
