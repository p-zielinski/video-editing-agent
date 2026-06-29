import { computeCutsRemovedSec } from "../render/audio-cuts.js";

function resolveWordIndexForSegment(seg, wordIndexes) {
  if (!wordIndexes) {
    return null;
  }
  const clipId = seg.audioRef?.clipId ?? seg.videoRef?.clipId;
  return clipId ? wordIndexes[clipId] ?? null : null;
}

export function resolveSegmentOutputDuration(seg, options = {}) {
  let base;
  if (seg.audioPolicy === "from_prev" || seg.audioPolicy === "from_next") {
    base = seg.videoOutSec - seg.videoInSec;
  } else {
    const videoDur = seg.videoOutSec - seg.videoInSec;
    const audioDur = seg.audioOutSec - seg.audioInSec;
    switch (seg.syncMode ?? "align_start") {
      case "fit_video_to_audio":
        base = audioDur;
        break;
      case "fit_audio_to_video":
        base = videoDur;
        break;
      case "loop_video":
        base = audioDur;
        break;
      default:
        base = Math.max(videoDur, audioDur);
    }
  }

  const { wordIndex } = options;
  if (!seg.cuts?.length || !wordIndex) {
    return base;
  }

  const rangeStart = seg.audioInSec ?? seg.videoInSec;
  const rangeEnd = seg.audioOutSec ?? seg.videoOutSec;
  const removed = computeCutsRemovedSec(seg.cuts, wordIndex, rangeStart, rangeEnd);
  return Math.max(0.01, base - removed);
}

export function buildOutputTimeline(output, options = {}) {
  const { wordIndexes } = options;
  let cursor = 0;
  const enriched = [];

  for (let i = 0; i < output.timeline.length; i += 1) {
    const seg = output.timeline[i];
    const overlap = seg.overlapSec ?? 0;
    const wordIndex = resolveWordIndexForSegment(seg, wordIndexes);
    const duration = resolveSegmentOutputDuration(seg, { wordIndex });
    const hasExplicitOutput = seg.outputStartSec != null && seg.outputEndSec != null;

    let outputStartSec = hasExplicitOutput ? seg.outputStartSec : cursor;
    let outputEndSec = hasExplicitOutput ? seg.outputEndSec : cursor + duration;

    if (i > 0 && seg.audioPolicy === "from_prev" && overlap > 0) {
      const prev = enriched[i - 1];
      prev.outputEndSec = outputStartSec + overlap;
    }

    enriched.push({ ...seg, outputStartSec, outputEndSec });
    cursor = hasExplicitOutput ? outputEndSec : cursor + duration;
  }

  return enriched;
}
