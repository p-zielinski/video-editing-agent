import { snapToNearestMusicBeat } from "../lib/music-beat-grid.js";

function findShortOutput(recipe) {
  return recipe.outputs?.find((output) => output.outputKind === "short");
}

function roundSec(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Snap short segment boundaries and retention beats to music bed grid.
 * @param {object} recipe
 * @param {{ musicBeatGrid?: object }} [options]
 */
export function enrichRecipeMusicBeatSnap(recipe, { musicBeatGrid = null } = {}) {
  const grid = musicBeatGrid ?? recipe.musicBeatGrid ?? null;
  const beatsSec = grid?.beatsSec ?? [];
  if (!beatsSec.length) {
    return recipe;
  }

  const shortOutput = findShortOutput(recipe);
  if (!shortOutput?.timeline?.length) {
    return recipe;
  }

  let boundarySnaps = 0;
  let momentSnaps = 0;

  for (let i = 1; i < shortOutput.timeline.length; i += 1) {
    const segment = shortOutput.timeline[i];
    const outputStart = segment.outputStartSec;
    if (outputStart == null) {
      continue;
    }
    const snap = snapToNearestMusicBeat(outputStart, beatsSec, 0.12);
    if (!snap.snapped) {
      continue;
    }
    const delta = snap.deltaSec;
    segment.outputStartSec = snap.snappedSec;
    if (segment.outputEndSec != null) {
      segment.outputEndSec = roundSec(segment.outputEndSec + delta);
    }
    boundarySnaps += 1;
  }

  for (const moment of recipe.creativeMoments ?? []) {
    if (moment.outputId !== shortOutput.outputId) {
      continue;
    }
    if (moment.retentionRole !== "beat" && moment.retentionRole !== "hook") {
      continue;
    }
    const snap = snapToNearestMusicBeat(moment.outputStartSec ?? 0, beatsSec, 0.12);
    if (!snap.snapped) {
      continue;
    }
    const delta = snap.deltaSec;
    moment.outputStartSec = snap.snappedSec;
    if (moment.outputEndSec != null) {
      moment.outputEndSec = roundSec(moment.outputEndSec + delta);
    }
    momentSnaps += 1;
  }

  if (boundarySnaps > 0 || momentSnaps > 0) {
    recipe.musicBeatSnapMeta = {
      applied: true,
      boundarySnaps,
      momentSnaps,
      trackId: grid.trackId,
      bpm: grid.bpm,
    };
  }

  return recipe;
}
