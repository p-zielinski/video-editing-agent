import {
  computeScaledMinRetentionBeats,
  isRetentionBeatMoment,
  mergeVlogRetentionProfile,
  shouldEnableVlogRetention,
} from "../editorial/shorts-retention.js";
import {
  computeExemptDurationSec,
  effectiveGapSec,
  resolveRecipeNarrativeProfile,
  resolveSlowBreathOutputRanges,
} from "../lib/narrative-profile.js";

const PATTERN_INTERRUPT_WINDOW_SEC = 600;
const DEFAULT_MAX_PATTERN_INTERRUPTS_PER_10_MIN = 1;

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

function validateMinRetentionBeats(output, profile, moments, durationSec, exemptRanges) {
  const beatMoments = moments.filter((moment) => isVlogRetentionBeatMoment(moment));
  const exemptDurationSec = computeExemptDurationSec(exemptRanges);
  const effectiveDurationSec = Math.max(0, durationSec - exemptDurationSec);
  const required = computeScaledMinRetentionBeats(effectiveDurationSec, profile);

  if (beatMoments.length >= required) {
    return [];
  }

  return [{
    severity: "error",
    code: "V22-VLOG-01",
    message: `Output ${output.outputId}: ${beatMoments.length} beatów vlog < min ${required} dla ${effectiveDurationSec.toFixed(0)}s`,
    outputId: output.outputId,
  }];
}

function validateCadence(output, profile, moments, durationSec, exemptRanges) {
  const maxGap = profile.retentionBeatIntervalSec + profile.retentionBeatToleranceSec;
  const beatMoments = moments.filter((moment) => isVlogRetentionBeatMoment(moment));
  const anchors = beatMoments
    .map((moment) => moment.outputStartSec)
    .sort((a, b) => a - b);

  if (anchors.length === 0 && durationSec > profile.hookWindowSec) {
    const hookGap = effectiveGapSec(profile.hookWindowSec, durationSec, exemptRanges);
    if (hookGap > maxGap) {
      return [{
        severity: "error",
        code: "V22-VLOG-02",
        message: `Output ${output.outputId}: brak retention beatów — cadence > ${maxGap}s`,
        outputId: output.outputId,
      }];
    }
    return [];
  }

  const issues = [];
  const hookWindow = profile.hookWindowSec;
  const points = [hookWindow, ...anchors, durationSec];
  for (let i = 1; i < points.length; i++) {
    const gap = effectiveGapSec(points[i - 1], points[i], exemptRanges);
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

export function resolveMaxPatternInterruptsPer10Min(recipe) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (narrativeProfile?.maxPatternInterruptsPer10Min != null) {
    return narrativeProfile.maxPatternInterruptsPer10Min;
  }
  return DEFAULT_MAX_PATTERN_INTERRUPTS_PER_10_MIN;
}

function countPatternInterruptsInWindow(times, windowStartSec, windowSec) {
  const windowEndSec = windowStartSec + windowSec;
  return times.filter(
    (timeSec) => timeSec >= windowStartSec && timeSec < windowEndSec,
  ).length;
}

function validatePatternInterruptDensity(
  output,
  moments,
  durationSec,
  maxPer10Min,
  { warnAtLimit = true } = {},
) {
  const patternInterruptTimes = moments
    .filter((moment) => moment.techniqueId === "pattern_interrupt")
    .map((moment) => moment.outputStartSec ?? moment.anchorSec ?? 0)
    .sort((a, b) => a - b);

  if (patternInterruptTimes.length === 0) {
    return [];
  }

  const windowStarts = new Set([0, ...patternInterruptTimes]);
  const issues = [];
  let warnedAtLimit = false;

  for (const windowStartSec of [...windowStarts].sort((a, b) => a - b)) {
    if (windowStartSec > durationSec) {
      break;
    }
    const count = countPatternInterruptsInWindow(
      patternInterruptTimes,
      windowStartSec,
      PATTERN_INTERRUPT_WINDOW_SEC,
    );
    if (count > maxPer10Min) {
      return [{
        severity: "error",
        code: "V22-VLOG-06",
        message: `Output ${output.outputId}: ${count} pattern_interrupt w oknie 10 min (max ${maxPer10Min})`,
        outputId: output.outputId,
      }];
    }
    if (count === maxPer10Min && maxPer10Min > 0 && warnAtLimit && !warnedAtLimit) {
      issues.push({
        severity: "warning",
        code: "V22-VLOG-06",
        message: `Output ${output.outputId}: ${count} pattern_interrupt w oknie 10 min — limit ${maxPer10Min}`,
        outputId: output.outputId,
      });
      warnedAtLimit = true;
    }
  }

  return issues;
}

function resolveBeatTargetSecs(beatTargets, outputId) {
  if (!beatTargets?.length) {
    return [];
  }

  if (typeof beatTargets[0] === "number") {
    return beatTargets;
  }

  return beatTargets
    .filter((entry) => !entry.outputId || entry.outputId === outputId)
    .map((entry) => entry.targetSec);
}

function validateBeatTargetAlignment(output, profile, moments, durationSec, beatTargets) {
  const targetSecs = resolveBeatTargetSecs(beatTargets, output.outputId);
  if (!targetSecs.length) {
    return [];
  }

  const tolerance = profile.retentionBeatToleranceSec;
  const beatMoments = moments.filter((moment) => isVlogRetentionBeatMoment(moment));
  const issues = [];

  for (const targetSec of targetSecs) {
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
 * Walidacja gramatyki retencji vlog 16:9 (V22-VLOG-01 … V22-VLOG-06).
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

  const mainOutputs = getMainOutputs(recipe);
  if (!mainOutputs.length) {
    return [];
  }

  const runFullVlogValidation = shouldRunVlogRetentionValidation(recipe);
  const explicitBeatTargets = options.retentionBeatTargets ?? recipe.retentionBeatTargets;
  const maxPatternInterruptsPer10Min = resolveMaxPatternInterruptsPer10Min(recipe);
  const hasExplicitPatternInterruptCap = resolveRecipeNarrativeProfile(recipe)
    ?.maxPatternInterruptsPer10Min != null;
  const {
    abstraction = null,
    timelineIndex = null,
    wordIndexes = null,
  } = options;

  const issues = [];
  for (const output of mainOutputs) {
    const durationSec = estimateOutputDurationSec(output);
    const moments = getMomentsForOutput(recipe, output.outputId);
    const exemptRanges = resolveSlowBreathOutputRanges(
      recipe,
      output,
      abstraction,
      timelineIndex,
      wordIndexes,
    );

    if (runFullVlogValidation) {
      issues.push(
        ...validateMinRetentionBeats(output, profile, moments, durationSec, exemptRanges),
        ...validateCadence(output, profile, moments, durationSec, exemptRanges),
        ...validateAggressiveBeatTechniques(output, moments),
        ...validateTechniqueRotation(output, moments),
        ...(explicitBeatTargets?.length
          ? validateBeatTargetAlignment(output, profile, moments, durationSec, explicitBeatTargets)
          : []),
      );
    }

    issues.push(
      ...validatePatternInterruptDensity(
        output,
        moments,
        durationSec,
        maxPatternInterruptsPer10Min,
        { warnAtLimit: !hasExplicitPatternInterruptCap },
      ),
    );
  }

  return issues;
}
