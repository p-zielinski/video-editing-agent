/**
 * Delivery / vocal engagement analysis — JS merge and index rollup.
 */

export const ENGAGEMENT_GRADES = ["engaging", "neutral", "flat"];

export function summarizeDeliveryForIndex(deliveryAnalysis) {
  if (!deliveryAnalysis?.clipSummary) {
    return {};
  }

  const { clipSummary } = deliveryAnalysis;
  return {
    deliveryGrade: clipSummary.engagementGrade ?? null,
    deliveryScore: clipSummary.engagementScore ?? null,
    deliveryDominantIssues: clipSummary.dominantIssues ?? [],
    flatDeliveryWindowCount: clipSummary.flatWindowCount ?? 0,
  };
}

export function buildFlatDeliveryWindows(deliveryAnalysis, limit = 8) {
  const windows = deliveryAnalysis?.clipSummary?.flatDeliveryWindows ?? [];
  return windows.slice(0, limit).map((window) => ({
    startSec: window.startSec,
    endSec: window.endSec,
    engagementScore: window.engagementScore,
    issues: window.issues ?? [],
  }));
}

export function buildDeliveryHints(deliveryAnalysis, { limit = 6 } = {}) {
  if (!deliveryAnalysis?.clipSummary) {
    return null;
  }

  const { clipSummary } = deliveryAnalysis;
  const flatWindows = buildFlatDeliveryWindows(deliveryAnalysis, limit);

  return {
    engagementGrade: clipSummary.engagementGrade,
    engagementScore: clipSummary.engagementScore,
    dominantIssues: clipSummary.dominantIssues ?? [],
    flatDeliveryWindows: flatWindows,
    recommendedRepairs: recommendRepairs(clipSummary, flatWindows),
  };
}

export function recommendRepairs(clipSummary, flatWindows = []) {
  const repairs = [];
  const issues = new Set(clipSummary?.dominantIssues ?? []);
  const grade = clipSummary?.engagementGrade;

  if (grade === "flat" || grade === "neutral") {
    repairs.push("editorial_pacing");
  }
  if (issues.has("steady_energy") || issues.has("flat_pitch") || grade === "flat") {
    repairs.push("dsp_polish");
  }
  if (
    flatWindows.length > 0
    && (issues.has("flat_pitch") || issues.has("steady_pace"))
  ) {
    repairs.push("localized_emphasis");
  }
  if (issues.has("high_fillers")) {
    repairs.push("filler_cuts");
  }

  return [...new Set(repairs)];
}

export function buildEngagementRepairCandidates(perClipAnalysis, clipRegistry) {
  const candidates = [];

  for (const analysis of perClipAnalysis ?? []) {
    const delivery = analysis.deliveryAnalysis;
    if (!delivery?.clipSummary) {
      continue;
    }

    const clip = clipRegistry?.find((entry) => entry.clipId === analysis.clipId);
    if (clip && clip.hasSpeech === false) {
      continue;
    }

    const { engagementGrade, engagementScore, dominantIssues } = delivery.clipSummary;
    if (engagementGrade !== "flat" && engagementGrade !== "neutral") {
      continue;
    }

    const flatWindows = buildFlatDeliveryWindows(delivery, 4);
    if (flatWindows.length === 0 && engagementGrade !== "flat") {
      continue;
    }

    candidates.push({
      candidateId: `delivery_${analysis.clipId}`,
      clipId: analysis.clipId,
      engagementGrade,
      engagementScore,
      dominantIssues: dominantIssues ?? [],
      flatDeliveryWindows: flatWindows,
      recommendedRepairs: recommendRepairs(delivery.clipSummary, flatWindows),
    });
  }

  return candidates;
}
