export function resolveSegmentOutputDuration(seg) {
  if (seg.audioPolicy === "from_prev" || seg.audioPolicy === "from_next") {
    return seg.videoOutSec - seg.videoInSec;
  }
  const videoDur = seg.videoOutSec - seg.videoInSec;
  const audioDur = seg.audioOutSec - seg.audioInSec;
  switch (seg.syncMode ?? "align_start") {
    case "fit_video_to_audio":
      return audioDur;
    case "fit_audio_to_video":
      return videoDur;
    case "loop_video":
      return audioDur;
    default:
      return Math.max(videoDur, audioDur);
  }
}

export function buildOutputTimeline(output) {
  let cursor = 0;
  const enriched = [];

  for (let i = 0; i < output.timeline.length; i += 1) {
    const seg = output.timeline[i];
    const overlap = seg.overlapSec ?? 0;
    const duration = resolveSegmentOutputDuration(seg);
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
