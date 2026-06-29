import {
  computeScaledMinRetentionBeats,
  isRetentionBeatMoment,
  mergeVlogRetentionProfile,
  shouldEnableVlogRetention,
} from "../editorial/shorts-retention.js";

const AGGRESSIVE_VLOG_TECHNIQUES = new Set([
  "jump_cut",
  "hard_cut_energy",
  "pattern_interrupt",
  "snap_zoom",
]);

function estimateOutputDurationSec(output) {
  if (output.targetDurationSec) {
    return output.targetDurationSec;
  }
  let maxSec = 0;
  for (const seg of output.timeline ?? []) {
    const end = seg.outputEndSec
      ?? (seg.outputStartSec ?? 0) + (seg.videoOutSec - seg.videoInSec);
    maxSec = Math.max(maxSec, end);
  }
  return maxSec;
}

function getMainOutputs(recipe) {
  const outputs = recipe.outputs ?? [];
  const mains = outputs.filter(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
  if (mains.length > 0) {
    return mains;
  }
  const first169 = outputs.find((output) => output.format === "16:9");
  return first169 ? [first169] : [];
}

function getMomentsForOutput(recipe, outputId) {
  return (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === outputId,
  );
}

/**
 * Beat on main: retentionRole beat (incl. vlog rotation techniques when role is beat).
 * @param {object} moment
 */
export function isVlogRetentionBeatMoment(moment) {
  if (moment.retentionRole === "beat") {
    return true;
  }
  if (moment.retentionRole) {
    return false;
  }
  return isRetentionBeatMoment(moment);
}

/**
 * @param {object} recipe
 */
export function shouldRunVlogRetentionValidation(recipe = {}) {
  const vlogRetentionProfile = recipe.vlogRetentionProfile ?? {};
  if (vlogRetentionProfile.enabled === false) {
    return false;
  }
  if (vlogRetentionProfile.enabled === true) {
    return true;
  }

  const legacy = recipe.version === "2.0" || recipe.version === "2.1";
  if (legacy) {
    return false;
  }

  return shouldEnableVlogRetention({
    outputs: recipe.outputs ?? [],
    requiredFormats: recipe.batchContext?.requiredFormats ?? [],
    vlogRetentionProfile,
  });
}

function validateMinRetentionBeats(output, profile, moments, durationSec) {
  const beatMoments = moments.filter((moment) => isVlogRetentionBeatMoment(moment));
  const required = computeScaledMinRetentionBeats(durationSec, profile);

  if (beatMoments.length >= required) {
    return [];
  }

  return [{
    severity: "error",
    code: "V22-VLOG-01",
    message: `Output ${output.outputId}: ${beatMoments.length} beatów vlog < min ${required} dla ${durationSec.toFixed(0)}s`,
    outputId: output.outputId,
  }];
}

function validateCadence(output, profile, moments, durationSec) {
  const maxGap = profile.retentionBeatIntervalSec + profile.retentionBeatToleranceSec;
  const beatMoments = moments.filter((moment) => isVlogRetentionBeatMoment(moment));
  const anchors = beatMoments
    .map((moment) => moment.outputStartSec)
    .sort((a, b) => a - b);

  if (anchors.length === 0 && durationSec > profile.hookWindowSec) {
    return [{
      severity: "error",
      code: "V22-VLOG-02",
      message: `Output ${output.outputId}: brak retention beatów — cadence > ${maxGap}s`,
      outputId: output.outputId,
    }];
  }

  const issues = [];
  const hookWindow = profile.hookWindowSec;
  const points = [hookWindow, ...anchors, durationSec];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i] - points[i - 1];
    if (gap > maxGap) {
      issues.push({
        severity: "error",
        code: "V22-VLOG-02",
        message: `Output ${output.outputId}: luka ${gap.toFixed(1)}s między beatami > max ${maxGap}s`,
        outputId: output.outputId,
      });
      break;
    }
  }

  return issues;
}

function validateAggressiveBeatTechniques(output, moments) {
  const issues = [];
  for (const moment of moments) {
    if (!isVlogRetentionBeatMoment(moment)) {
      continue;
    }
    if (!AGGRESSIVE_VLOG_TECHNIQUES.has(moment.techniqueId)) {
      continue;
    }
    issues.push({
      severity: "warning",
      code: "V22-VLOG-03",
      message: `Moment ${moment.momentId}: agresywna technika ${moment.techniqueId} na beat vlog main`,
      outputId: output.outputId,
      momentId: moment.momentId,
    });
  }
  return issues;
}

function validateTechniqueRotation(output, moments) {
  const beatMoments = moments
    .filter((moment) => isVlogRetentionBeatMoment(moment))
    .sort((a, b) => a.outputStartSec - b.outputStartSec);

  const issues = [];
  let runLength = 1;
  for (let i = 1; i < beatMoments.length; i++) {
    if (beatMoments[i].techniqueId === beatMoments[i - 1].techniqueId) {
      runLength += 1;
      if (runLength >= 3) {
        issues.push({
          severity: "warning",
          code: "V22-VLOG-04",
          message: `Output ${output.outputId}: 3+ kolejne beaty z ${beatMoments[i].techniqueId} — rotacja monotonna`,
          outputId: output.outputId,
        });
        break;
      }
    } else {
      runLength = 1;
    }
  }
  return issues;
}

function validateBeatTargetAlignment(output, profile, moments, durationSec, beatTargets) {
  if (!beatTargets?.length) {
    return [];
  }

  const tolerance = profile.retentionBeatToleranceSec;
  const beatMoments = moments.filter((moment) => isVlogRetentionBeatMoment(moment));
  const issues = [];

  for (const targetSec of beatTargets) {
    const hasNearby = beatMoments.some((moment) => {
      const anchor = moment.outputStartSec ?? moment.anchorSec ?? 0;
      return Math.abs(anchor - targetSec) <= tolerance;
    });
    if (!hasNearby) {
      issues.push({
        severity: "warning",
        code: "V22-VLOG-05",
        message: `Output ${output.outputId}: brak beatu w ±${tolerance}s od target ${targetSec}s`,
        outputId: output.outputId,
      });
    }
  }

  return issues;
}

/**
 * Walidacja gramatyki retencji vlog 16:9 (V22-VLOG-01 … V22-VLOG-05).
 */
export function validateVlogRetention(recipe, catalog, options = {}) {
  void catalog;

  const requiredFormats = options.requiredFormats
    ?? recipe.batchContext?.requiredFormats
    ?? [];

  const profile = mergeVlogRetentionProfile(
    recipe.vlogRetentionProfile ?? {},
    {
      outputs: recipe.outputs ?? [],
      requiredFormats,
    },
  );

  if (!shouldRunVlogRetentionValidation(recipe)) {
    return [];
  }

  const explicitBeatTargets = options.retentionBeatTargets ?? recipe.retentionBeatTargets;

  const issues = [];
  const mainOutputs = getMainOutputs(recipe);

  for (const output of mainOutputs) {
    const durationSec = estimateOutputDurationSec(output);
    const moments = getMomentsForOutput(recipe, output.outputId);

    issues.push(
      ...validateMinRetentionBeats(output, profile, moments, durationSec),
      ...validateCadence(output, profile, moments, durationSec),
      ...validateAggressiveBeatTechniques(output, moments),
      ...validateTechniqueRotation(output, moments),
      ...(explicitBeatTargets?.length
        ? validateBeatTargetAlignment(output, profile, moments, durationSec, explicitBeatTargets)
        : []),
    );
  }

  return issues;
}
