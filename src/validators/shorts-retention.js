import {
  computeScaledMinRetentionBeats,
  DEFAULT_SHORTS_RETENTION_PROFILE,
  isHookMoment,
  isHookTechniqueId,
  isLargeHookOverlay,
  isRetentionBeatMoment,
  LARGE_HOOK_OVERLAY_BUDGET_WINDOW_SEC,
  mergeShortsRetentionProfile,
  shouldRunShortsRetentionValidation,
} from "../editorial/shorts-retention.js";

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

function getShortOutputs(recipe) {
  return (recipe.outputs ?? []).filter((output) => output.outputKind === "short");
}

function getMomentsForOutput(recipe, outputId) {
  return (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === outputId,
  );
}

function collectTextOverlays(output) {
  const overlays = [];
  for (const seg of output.timeline ?? []) {
    const segStart = seg.outputStartSec ?? 0;
    for (const overlay of seg.textOverlays ?? []) {
      const start = overlay.outputStartSec ?? segStart;
      overlays.push({
        ...overlay,
        outputStartSec: start,
        outputEndSec: overlay.outputEndSec ?? start + 4,
      });
    }
  }
  return overlays;
}

function retentionSeverity(creativityLevel, code) {
  const strictCodes = new Set(["V22-01", "V22-02", "V22-04"]);
  if (creativityLevel === "shorts" && strictCodes.has(code)) {
    return "error";
  }
  return "warning";
}

function isHookLikeMoment(moment) {
  return moment.retentionRole === "hook"
    || moment.techniqueId === "hook_title_overlay"
    || (moment.retentionRole !== "beat"
      && moment.retentionRole !== "payoff"
      && isHookTechniqueId(moment.techniqueId));
}

function validateHookMoment(output, profile, moments, severity) {
  if (!profile.requireHookMoment) {
    return [];
  }

  const hookWindow = profile.hookWindowSec;
  const hasHook = moments.some((moment) =>
    moment.outputStartSec < hookWindow && isHookMoment(moment),
  );

  if (hasHook) {
    return [];
  }

  return [{
    severity,
    code: "V22-01",
    message: `Output ${output.outputId}: brak hook momentu w [0, ${hookWindow}s)`,
    outputId: output.outputId,
  }];
}

function validateHookOverlay(output, profile, moments, overlays, severity) {
  if (!profile.requireHookOverlay) {
    return [];
  }

  const hookWindow = profile.hookWindowSec;
  const hasOverlay = overlays.some(
    (overlay) => overlay.role === "hook" && overlay.outputStartSec < hookWindow,
  );
  const hasTechnique = moments.some(
    (moment) =>
      moment.outputStartSec < hookWindow
      && moment.techniqueId === "hook_title_overlay",
  );

  if (hasOverlay || hasTechnique) {
    return [];
  }

  return [{
    severity,
    code: "V22-02",
    message: `Output ${output.outputId}: brak hook overlay w [0, ${hookWindow}s)`,
    outputId: output.outputId,
  }];
}

function validateMinRetentionBeats(output, profile, moments, durationSec, severity) {
  const beatMoments = moments.filter((moment) => isRetentionBeatMoment(moment));
  const required = computeScaledMinRetentionBeats(durationSec, profile);

  if (beatMoments.length >= required) {
    return [];
  }

  return [{
    severity,
    code: "V22-03",
    message: `Output ${output.outputId}: ${beatMoments.length} beatów (retentionRole: beat) < min ${required} dla ${durationSec.toFixed(0)}s`,
    outputId: output.outputId,
  }];
}

function validateCadence(output, profile, moments, durationSec, creativityLevel) {
  const maxGap = profile.retentionBeatIntervalSec + profile.retentionBeatToleranceSec;
  const beatMoments = moments.filter((moment) => isRetentionBeatMoment(moment));
  const anchors = beatMoments
    .map((moment) => moment.outputStartSec)
    .sort((a, b) => a - b);

  if (anchors.length === 0 && durationSec > profile.hookWindowSec) {
    return [{
      severity: retentionSeverity(creativityLevel, "V22-04"),
      code: "V22-04",
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
        severity: retentionSeverity(creativityLevel, "V22-04"),
        code: "V22-04",
        message: `Output ${output.outputId}: luka ${gap.toFixed(1)}s między beatami > max ${maxGap}s`,
        outputId: output.outputId,
      });
      break;
    }
  }

  return issues;
}

function validateHookWindowPlacement(output, profile, moments, overlays) {
  const hookWindow = profile.hookWindowSec;
  const issues = [];

  for (const moment of moments) {
    if (isHookLikeMoment(moment) && moment.outputStartSec >= hookWindow) {
      issues.push({
        severity: "error",
        code: "V22-05",
        message: `Moment ${moment.momentId}: hook (${moment.techniqueId}) poza oknem [0, ${hookWindow}s)`,
        outputId: output.outputId,
        momentId: moment.momentId,
      });
    }
  }

  for (const overlay of overlays) {
    if (overlay.role === "hook" && overlay.outputStartSec >= hookWindow) {
      issues.push({
        severity: "error",
        code: "V22-05",
        message: `Hook overlay "${overlay.text}" poza oknem [0, ${hookWindow}s)`,
        outputId: output.outputId,
      });
    }
    if (
      overlay.style?.startsWith("hook_")
      && overlay.outputStartSec >= hookWindow
    ) {
      issues.push({
        severity: "error",
        code: "V22-05",
        message: `Overlay style ${overlay.style} poza hook window [0, ${hookWindow}s)`,
        outputId: output.outputId,
      });
    }
  }

  return issues;
}

function validateHookOverlayDuration(output, profile, overlays) {
  const maxDuration = profile.maxHookOverlayDurationSec
    ?? DEFAULT_SHORTS_RETENTION_PROFILE.maxHookOverlayDurationSec;
  const issues = [];

  for (const overlay of overlays) {
    if (!isLargeHookOverlay(overlay)) {
      continue;
    }
    const duration = overlay.outputEndSec - overlay.outputStartSec;
    if (duration > maxDuration) {
      issues.push({
        severity: "warning",
        code: "V22-07",
        message: `Hook overlay "${overlay.text}" trwa ${duration.toFixed(1)}s > max ${maxDuration}s`,
        outputId: output.outputId,
      });
    }
  }

  return issues;
}

function validateLargeHookOverlayBudget(output, overlays, durationSec) {
  const issues = [];
  const largeHooks = overlays
    .filter((overlay) => isLargeHookOverlay(overlay))
    .sort((a, b) => a.outputStartSec - b.outputStartSec);

  for (let i = 0; i < largeHooks.length; i++) {
    const windowStart = largeHooks[i].outputStartSec;
    const windowEnd = windowStart + LARGE_HOOK_OVERLAY_BUDGET_WINDOW_SEC;
    const inWindow = largeHooks.filter(
      (overlay) =>
        overlay.outputStartSec >= windowStart
        && overlay.outputStartSec < Math.min(windowEnd, durationSec),
    );
    if (inWindow.length > 1) {
      issues.push({
        severity: "warning",
        code: "V22-07",
        message: `Output ${output.outputId}: ${inWindow.length} duże hook overlay w ${LARGE_HOOK_OVERLAY_BUDGET_WINDOW_SEC}s od ${windowStart.toFixed(1)}s (max 1)`,
        outputId: output.outputId,
      });
      break;
    }
  }

  return issues;
}

/**
 * V22-06 — graphics creativeMoments with requiresOutputKind: short only on short outputs.
 * textOverlays (e.g. main chapter_card style) are not creativeMoments and are exempt.
 */
function validateGraphicsOutputKind(output, catalog, moments) {
  const issues = [];

  for (const moment of moments) {
    const technique = catalog.byId.get(moment.techniqueId);
    if (!technique || technique.category !== "graphics") {
      continue;
    }
    if (
      technique.constraints?.requiresOutputKind === "short"
      && output.outputKind !== "short"
    ) {
      issues.push({
        severity: "error",
        code: "V22-06",
        message: `Moment ${moment.momentId}: ${technique.id} wymaga outputKind short`,
        outputId: output.outputId,
        momentId: moment.momentId,
      });
    }
  }

  return issues;
}

/**
 * Walidacja gramatyki retencji shortów (V22-01 … V22-07).
 * Dla outputów main profil jest ignorowany.
 */
export function validateShortsRetention(recipe, catalog, options = {}) {
  const creativityLevel = options.creativityLevel
    ?? recipe.creativityProfile?.level
    ?? "balanced";

  const requiredFormats = options.requiredFormats
    ?? recipe.batchContext?.requiredFormats
    ?? [];

  const profile = mergeShortsRetentionProfile(
    recipe.shortsRetentionProfile ?? {},
    {
      packRetentionDefaults: catalog.pack?.retentionDefaults,
      creativityProfile: recipe.creativityProfile ?? {},
      outputs: recipe.outputs ?? [],
      requiredFormats,
      userContext: options.userContext ?? "",
    },
  );

  if (!shouldRunShortsRetentionValidation({
    recipeVersion: recipe.version,
    outputs: recipe.outputs ?? [],
    requiredFormats,
    creativityProfile: recipe.creativityProfile ?? {},
    userContext: options.userContext ?? "",
    shortsRetentionProfile: recipe.shortsRetentionProfile ?? {},
  })) {
    return [];
  }

  const issues = [];
  const shortOutputs = getShortOutputs(recipe);

  for (const output of shortOutputs) {
    const durationSec = estimateOutputDurationSec(output);
    const moments = getMomentsForOutput(recipe, output.outputId);
    const overlays = collectTextOverlays(output);
    const baseSeverity = retentionSeverity(creativityLevel, "V22-01");

    issues.push(
      ...validateHookMoment(output, profile, moments, baseSeverity),
      ...validateHookOverlay(output, profile, moments, overlays, baseSeverity),
      ...validateMinRetentionBeats(
        output,
        profile,
        moments,
        durationSec,
        retentionSeverity(creativityLevel, "V22-03"),
      ),
      ...validateCadence(output, profile, moments, durationSec, creativityLevel),
      ...validateHookWindowPlacement(output, profile, moments, overlays),
      ...validateHookOverlayDuration(output, profile, overlays),
      ...validateLargeHookOverlayBudget(output, overlays, durationSec),
      ...validateGraphicsOutputKind(output, catalog, moments),
    );
  }

  for (const output of recipe.outputs ?? []) {
    if (output.outputKind === "short") {
      continue;
    }
    const moments = getMomentsForOutput(recipe, output.outputId);
    issues.push(...validateGraphicsOutputKind(output, catalog, moments));
  }

  return issues;
}
