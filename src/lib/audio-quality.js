/**
 * Merge Python audioQuality heuristics with PANNs wind detection and clip metadata.
 */

/**
 * @param {Array<{ editorialTag?: string, score?: number, startSec?: number, endSec?: number }>} audioEvents
 * @param {number} durationSec
 */
export function computePannsWindScore(audioEvents = [], durationSec = 1) {
  const windEvents = audioEvents.filter((event) => event.editorialTag === "wind");
  if (windEvents.length === 0) {
    return 0;
  }

  const peakScore = Math.max(...windEvents.map((event) => event.score ?? 0));
  const windDuration = windEvents.reduce(
    (sum, event) => sum + Math.max(0, (event.endSec ?? 0) - (event.startSec ?? 0)),
    0,
  );
  const coverageRatio = windDuration / Math.max(0.1, durationSec);
  return Math.min(1, Math.max(peakScore, coverageRatio * 1.5));
}

/**
 * @param {object} pythonQuality
 * @param {{ audioEvents?: object[], durationSec?: number, clipId?: string, hasSpeech?: boolean }} context
 */
export function finalizeAudioQuality(pythonQuality, context = {}) {
  const {
    audioEvents = [],
    durationSec = 0,
    clipId = "",
    hasSpeech: clipHasSpeech = false,
  } = context;

  const pannsWind = computePannsWindScore(audioEvents, durationSec);
  const heuristicWind = pythonQuality?.windScore ?? 0;
  const windScore = Math.round(Math.max(heuristicWind, pannsWind) * 1000) / 1000;

  const hasSpeech = clipHasSpeech || pythonQuality?.hasSpeech === true;
  const issues = [...(pythonQuality?.issues ?? [])];
  if (windScore >= 0.45 && !issues.includes("wind")) {
    issues.push("wind");
  }

  let enhancementRecommended = pythonQuality?.enhancementRecommended === true;
  const reasons = [...(pythonQuality?.reasons ?? [])];

  if (hasSpeech && windScore >= 0.45 && !enhancementRecommended) {
    enhancementRecommended = true;
    if (!reasons.includes("wind_detected")) {
      reasons.push("wind_detected");
    }
  }

  if (!hasSpeech) {
    enhancementRecommended = false;
  }

  const enhancementCandidateId = enhancementRecommended && clipId
    ? `enh_${clipId}`
    : undefined;

  return {
    ...pythonQuality,
    hasSpeech,
    windScore,
    issues,
    enhancementRecommended,
    reasons,
    ...(enhancementCandidateId ? { enhancementCandidateId } : {}),
  };
}

/**
 * @param {object | null | undefined} audioQuality
 */
export function summarizeAudioQualityForIndex(audioQuality) {
  if (!audioQuality) {
    return {};
  }

  return {
    audioQualityGrade: audioQuality.grade,
    audioQualityScore: audioQuality.qualityScore,
    estimatedSnrDb: audioQuality.estimatedSnrDb ?? null,
    windScore: audioQuality.windScore ?? 0,
    enhancementCandidateId: audioQuality.enhancementCandidateId ?? null,
  };
}

/**
 * @param {Array<{ clipId?: string, audioQuality?: object }>} perClipAnalysis
 * @param {Array<{ clipId?: string, hasSpeech?: boolean }>} clipRegistry
 */
export function buildEnhancementCandidatesBrief(perClipAnalysis = [], clipRegistry = []) {
  const speechByClip = new Map(
    (clipRegistry ?? []).map((clip) => [clip.clipId, clip.hasSpeech === true]),
  );

  return (perClipAnalysis ?? [])
    .filter((analysis) => analysis?.audioQuality?.enhancementRecommended)
    .map((analysis) => ({
      candidateId: analysis.audioQuality.enhancementCandidateId
        ?? `enh_${analysis.clipId}`,
      clipId: analysis.clipId,
      grade: analysis.audioQuality.grade,
      qualityScore: analysis.audioQuality.qualityScore,
      estimatedSnrDb: analysis.audioQuality.estimatedSnrDb ?? null,
      windScore: analysis.audioQuality.windScore ?? null,
      hasSpeech: speechByClip.get(analysis.clipId) ?? analysis.audioQuality.hasSpeech === true,
      issues: analysis.audioQuality.issues ?? [],
      reasons: analysis.audioQuality.reasons ?? [],
    }));
}
