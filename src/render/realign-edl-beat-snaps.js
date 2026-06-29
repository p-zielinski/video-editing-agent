const SNAP_EPSILON_SEC = 0.001;

/**
 * Cumulative output-timeline shift at `outputSec` from beat snaps (original join positions).
 */
export function shiftSecAtOutputTime(beatSnaps, outputSec) {
  if (!beatSnaps?.length || !Number.isFinite(outputSec)) {
    return 0;
  }

  let shift = 0;
  for (const snap of beatSnaps) {
    if (Math.abs(snap.deltaSec ?? 0) <= SNAP_EPSILON_SEC) {
      continue;
    }
    if (outputSec >= (snap.originalJoinSec ?? 0) - SNAP_EPSILON_SEC) {
      shift += snap.deltaSec;
    }
  }
  return shift;
}

function shiftTimedEntry(entry, beatSnaps) {
  if (!entry || !Number.isFinite(entry.outputStartSec)) {
    return;
  }
  const startShift = shiftSecAtOutputTime(beatSnaps, entry.outputStartSec);
  entry.outputStartSec += startShift;
  if (Number.isFinite(entry.outputEndSec)) {
    const endShift = shiftSecAtOutputTime(beatSnaps, entry.outputEndSec);
    entry.outputEndSec += endShift;
  }
}

function shiftSubtitles(subtitles, beatSnaps) {
  if (!subtitles || subtitles.policy === "off") {
    return;
  }
  shiftTimedEntry(subtitles, beatSnaps);
  for (const word of subtitles.words ?? []) {
    shiftTimedEntry(word, beatSnaps);
  }
}

/**
 * Realign EDL output timeline after beat-snap trims shortened segment files at joins.
 * Mutates `edl` in place.
 */
export function realignEdlAfterBeatSnaps(edl, beatSnaps) {
  if (!edl?.segments?.length || !beatSnaps?.length) {
    return edl;
  }

  const applicableSnaps = beatSnaps.filter(
    (snap) => Math.abs(snap.deltaSec ?? 0) > SNAP_EPSILON_SEC,
  );
  if (applicableSnaps.length === 0) {
    return edl;
  }

  const sorted = [...applicableSnaps].sort((a, b) => a.boundaryIndex - b.boundaryIndex);

  for (const snap of sorted) {
    const { boundaryIndex, deltaSec } = snap;
    const segBefore = edl.segments[boundaryIndex - 1];
    if (segBefore) {
      segBefore.outputEndSec = (segBefore.outputEndSec ?? 0) + deltaSec;
    }
    for (let i = boundaryIndex; i < edl.segments.length; i += 1) {
      const seg = edl.segments[i];
      seg.outputStartSec = (seg.outputStartSec ?? 0) + deltaSec;
      seg.outputEndSec = (seg.outputEndSec ?? 0) + deltaSec;
    }
  }

  for (const moment of edl.creativeMoments ?? []) {
    shiftTimedEntry(moment, sorted);
  }

  for (const seg of edl.segments) {
    shiftSubtitles(seg.subtitles, sorted);
    for (const overlay of seg.textOverlays ?? []) {
      shiftTimedEntry(overlay, sorted);
    }
  }

  edl.durationSec = Math.max(...edl.segments.map((seg) => seg.outputEndSec ?? 0));
  return edl;
}
