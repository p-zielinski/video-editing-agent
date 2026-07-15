import { collectCrossfadesAtBoundaries } from "../render/ffmpeg-concat.js";
import { hasJlCutOverlap } from "../render/audio-jlcut.js";
import { getTechniqueRenderSupport, isSyncSpeedSupported } from "../render/render-capabilities.js";

const JUMP_CUT_TECHNIQUES = new Set(["jump_cut", "hard_cut_energy"]);
const LIMITED_RENDER_SUPPORT = new Set(["stub", "partial"]);

function findSegmentForMoment(recipe, moment) {
  if (moment.segmentId) {
    for (const output of recipe.outputs ?? []) {
      const seg = output.timeline.find((s) => s.segmentId === moment.segmentId);
      if (seg) {
        return { segment: seg, outputId: output.outputId };
      }
    }
  }

  for (const output of recipe.outputs ?? []) {
    if (moment.outputId && output.outputId !== moment.outputId) {
      continue;
    }
    for (const seg of output.timeline) {
      const start = seg.outputStartSec ?? 0;
      const end = seg.outputEndSec ?? start + (seg.videoOutSec - seg.videoInSec);
      if (moment.outputStartSec >= start && moment.outputStartSec < end) {
        return { segment: seg, outputId: output.outputId };
      }
    }
  }

  return { segment: null, outputId: moment.outputId };
}

function reasonMentionsRenderLimitation(reason) {
  const text = String(reason ?? "").toLowerCase();
  return text.includes("stub") || text.includes("partial");
}

function isOverlappingSegment(segment) {
  if (!segment) {
    return false;
  }
  const policy = segment.audioPolicy ?? "from_video_ref";
  return (segment.overlapSec ?? 0) > 0
    || policy === "from_prev"
    || policy === "from_next";
}

function validateStubPartialReasons(recipe) {
  const issues = [];

  for (const moment of recipe.creativeMoments ?? []) {
    const support = getTechniqueRenderSupport(moment.techniqueId);
    if (!LIMITED_RENDER_SUPPORT.has(support)) {
      continue;
    }
    if (reasonMentionsRenderLimitation(moment.reason)) {
      continue;
    }
    issues.push({
      severity: "error",
      code: "V27-RENDER-01",
      message: `Moment ${moment.momentId ?? "?"}: ${moment.techniqueId} (${support}) wymaga reason wspominającego ograniczenie renderera (stub/partial)`,
      momentId: moment.momentId,
    });
  }

  return issues;
}

function validateProductionPartialCrossfade(recipe, qualityProfile) {
  if (qualityProfile !== "production") {
    return [];
  }

  const issues = [];
  const moments = recipe.creativeMoments ?? [];

  for (const output of recipe.outputs ?? []) {
    const segments = output.timeline ?? [];
    if (segments.length < 3 || hasJlCutOverlap(segments)) {
      continue;
    }

    const outputMoments = moments.filter(
      (m) => !m.outputId || m.outputId === output.outputId,
    );
    const boundaries = collectCrossfadesAtBoundaries(outputMoments, segments);
    const crossfadeCount = boundaries.filter(Boolean).length;
    if (crossfadeCount === 0) {
      continue;
    }

    const numBoundaries = segments.length - 1;
    const eligible = crossfadeCount === 1 || crossfadeCount === numBoundaries;
    if (!eligible) {
      issues.push({
        severity: "error",
        code: "V27-RENDER-02",
        message: `Output ${output.outputId}: crossfade na ${crossfadeCount}/${numBoundaries} joinach — renderer wymaga crossfade na każdym joinie lub dokładnie jednym (production)`,
        outputId: output.outputId,
      });
    }
  }

  return issues;
}

function validateSyncSpeed(recipe) {
  const issues = [];

  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      const speed = segment.speed ?? 1;
      if (speed === 1) {
        continue;
      }
      const syncMode = segment.syncMode ?? "align_start";
      const speedMode = segment.speedMode ?? "video_audio";
      if (!isSyncSpeedSupported(syncMode, speed, speedMode)) {
        issues.push({
          severity: "error",
          code: "V27-RENDER-03",
          message: `Segment ${segment.segmentId}: syncMode=${syncMode} + speed=${speed} (${speedMode}) nieobsługiwane przez renderer`,
          outputId: output.outputId,
          sceneId: segment.videoRef?.sceneId,
        });
      }
    }
  }

  return issues;
}

function validateJumpCutOnOverlappingSegment(recipe) {
  const issues = [];

  for (const moment of recipe.creativeMoments ?? []) {
    if (!JUMP_CUT_TECHNIQUES.has(moment.techniqueId)) {
      continue;
    }

    const { segment } = findSegmentForMoment(recipe, moment);
    if (!isOverlappingSegment(segment)) {
      continue;
    }
    if ((segment.timeCuts?.length ?? 0) > 0) {
      continue;
    }

    issues.push({
      severity: "warning",
      code: "V27-RENDER-04",
      message: `Moment ${moment.momentId ?? "?"}: ${moment.techniqueId} na segmencie J/L (${segment.segmentId}) bez timeCuts[] — renderer zastosuje pulse zamiast cięcia`,
      momentId: moment.momentId,
      outputId: moment.outputId,
    });
  }

  return issues;
}

function validateSilenceBeatWithoutCuts(recipe) {
  const issues = [];

  for (const moment of recipe.creativeMoments ?? []) {
    if (moment.techniqueId !== "silence_beat") {
      continue;
    }

    const { segment } = findSegmentForMoment(recipe, moment);
    if (!segment) {
      continue;
    }
    if ((segment.cuts?.length ?? 0) > 0) {
      continue;
    }

    const volumeFactor = moment.params?.volumeFactor ?? 0.3;
    if (volumeFactor === 0) {
      continue;
    }

    issues.push({
      severity: "warning",
      code: "V27-RENDER-05",
      message: `Moment ${moment.momentId ?? "?"}: silence_beat na segmencie ${segment.segmentId} bez cuts[] — dip głosu nie skraca dead air`,
      momentId: moment.momentId,
      outputId: moment.outputId,
    });
  }

  return issues;
}

/**
 * V27 render fidelity — stub/partial honesty, production crossfade, sync/speed, jump cuts, silence_beat.
 */
export function validateRenderFidelity(recipe, { qualityProfile = "lenient" } = {}) {
  return [
    ...validateStubPartialReasons(recipe),
    ...validateProductionPartialCrossfade(recipe, qualityProfile),
    ...validateSyncSpeed(recipe),
    ...validateJumpCutOnOverlappingSegment(recipe),
    ...validateSilenceBeatWithoutCuts(recipe),
  ];
}
