import fs from "node:fs";
import path from "node:path";
import { isRetentionBeatMoment } from "../editorial/shorts-retention.js";
import { validateRecipeV2 } from "../validators/recipe-v2.js";
import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";
import { readJson, writeJson, ARTIFACTS } from "../pipeline/work-paths.js";

function tryReadJson(workDir, artifactName) {
  const filePath = path.join(workDir, artifactName);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function percent(numerator, denominator) {
  if (!denominator || denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 1000) / 10;
}

function countSpeechWords(timelineIndex) {
  const words = timelineIndex?.words ?? [];
  return words.filter((w) => !w.isFiller).length;
}

function computeFillerRatio(timelineIndex) {
  const words = timelineIndex?.words ?? [];
  const speechWords = words.filter((w) => !w.isFiller).length;
  const fillers = words.filter((w) => w.isFiller).length;
  if (speechWords + fillers === 0) {
    return 0;
  }
  return Math.round((fillers / (speechWords + fillers)) * 1000) / 1000;
}

function computeAnchorMetrics(spatialIndex) {
  const scenes = spatialIndex?.scenes ?? [];
  const totalScenes = scenes.length;
  const scenesWithAnchors = scenes.filter((s) => (s.anchors ?? []).length > 0).length;
  const scenesWithFace = scenes.filter((s) =>
    (s.anchors ?? []).some((a) => a.type === "face"),
  ).length;

  return {
    anchorCoveragePercent: percent(scenesWithAnchors, totalScenes),
    faceAnchorPercent: percent(scenesWithFace, totalScenes),
    sceneCount: totalScenes,
    scenesWithAnchors,
    scenesWithFace,
  };
}

function computeL1FieldsPresentPercent(abstraction, timelineIndex) {
  const l1 = abstraction?.L1 ?? [];
  const sceneIds = (timelineIndex?.scenes ?? []).map((s) => s.sceneId);
  if (sceneIds.length === 0) {
    return 0;
  }

  const l1ByScene = new Map(l1.map((entry) => [entry.sceneId, entry]));
  let populated = 0;
  for (const sceneId of sceneIds) {
    const entry = l1ByScene.get(sceneId);
    if (entry && typeof entry.brollPotential === "number") {
      populated += 1;
    }
  }
  return percent(populated, sceneIds.length);
}

function countBrollPool(clipRegistry) {
  const clips = clipRegistry?.clipRegistry ?? clipRegistry ?? [];
  return clips.filter((c) => c.clipRole === "broll_pool").length;
}

function computeTopicMatchMetrics(topicIndex, threshold = 0.55) {
  const topics = topicIndex?.topics ?? [];
  if (topics.length === 0) {
    return {
      topicMatchRate: 0,
      avgBestMatchScore: 0,
      topicsWithMatch: 0,
      topicMatchThreshold: threshold,
    };
  }

  let topicsWithMatch = 0;
  let scoreSum = 0;
  for (const topic of topics) {
    const best = (topic.matchingScenes ?? []).reduce(
      (max, scene) => Math.max(max, scene.score ?? 0),
      0,
    );
    scoreSum += best;
    if (best >= threshold) {
      topicsWithMatch += 1;
    }
  }

  return {
    topicMatchRate: percent(topicsWithMatch, topics.length),
    avgBestMatchScore: Math.round((scoreSum / topics.length) * 1000) / 1000,
    topicsWithMatch,
    topicMatchThreshold: threshold,
    topicIndexVersion: topicIndex?.version ?? null,
  };
}

function loadRecipe(workDir) {
  const final = tryReadJson(workDir, ARTIFACTS.recipeFinal);
  if (final) {
    return final;
  }
  return tryReadJson(workDir, ARTIFACTS.recipeDraft);
}

function resolveBrollMatchThreshold(recipe, manifest) {
  return recipe?.batchContext?.brollMatchThreshold
    ?? manifest?.batchContext?.brollMatchThreshold
    ?? 0.55;
}

function collectQualityGateFailures({
  anchorCoveragePercent,
  topicMatchRate,
  l1FieldsPresentPercent,
  validationErrorCount,
}) {
  const failures = [];
  if (anchorCoveragePercent < 50) {
    failures.push("anchor_coverage_below_50");
  }
  if (topicMatchRate < 50) {
    failures.push("topic_match_rate_below_50");
  }
  if (l1FieldsPresentPercent < 80) {
    failures.push("l1_fields_present_below_80");
  }
  if (validationErrorCount > 0) {
    failures.push("recipe_validation_errors");
  }
  return failures;
}

function computeAudioMetrics(audioIndex) {
  const clips = audioIndex?.clips ?? [];
  const summary = audioIndex?.batchSummary ?? {};
  const totalBeats = clips.reduce((sum, c) => sum + (c.beatCount ?? 0), 0);
  return {
    audioClipCount: clips.length,
    avgVoiceLufs: summary.avgVoiceLufs ?? null,
    totalSilenceSec: summary.totalSilenceSec ?? 0,
    estimatedBpm: summary.estimatedBpm ?? null,
    totalBeatCount: totalBeats,
    dominantMood: summary.dominantMood ?? null,
  };
}

function countRetentionBeats(recipe) {
  if (!recipe) {
    return 0;
  }
  return (recipe.creativeMoments ?? []).filter((moment) => isRetentionBeatMoment(moment)).length;
}

function loadWordIndexes(workDir, catalog) {
  if (!catalog?.clips) {
    return [];
  }
  return catalog.clips.map((clip) => {
    try {
      return readJson(path.join(workDir, ARTIFACTS.words(clip.clipId)));
    } catch {
      return { clipId: clip.clipId, words: [] };
    }
  });
}

function detectStubDataWarnings(timelineIndex, catalog, workDir) {
  const warnings = [];

  const stubCaptions = (timelineIndex?.visionCaptions ?? []).filter(
    (entry) => /\[stub\]/i.test(entry.caption ?? ""),
  );
  if (stubCaptions.length > 0) {
    warnings.push("vision_captions_stub");
  }

  const clips = catalog?.clips ?? [];
  if (clips.length > 0) {
    const stubAudioClips = clips.filter((clip) => {
      const analysis = tryReadJson(workDir, ARTIFACTS.audioAnalysis(clip.clipId));
      return analysis?.analysisMode === "stub" || analysis?.eventDetectionMode === "stub";
    });
    if (stubAudioClips.length > 0) {
      warnings.push("audio_analysis_stub");
    }
  }

  return warnings;
}

function detectTopicIndexWarnings(topicIndex) {
  if (topicIndex?.version === "1.0") {
    return ["topic_index_keyword_only"];
  }
  return [];
}

export function buildBatchQualityReport(workDir) {
  const timelineIndex = tryReadJson(workDir, ARTIFACTS.timelineIndex);
  const spatialIndex = tryReadJson(workDir, ARTIFACTS.spatialIndex);
  const abstraction = tryReadJson(workDir, ARTIFACTS.abstraction);
  const topicIndex = tryReadJson(workDir, ARTIFACTS.topicIndex);
  const clipRegistry = tryReadJson(workDir, ARTIFACTS.clipRegistry);
  const catalog = tryReadJson(workDir, ARTIFACTS.sceneCatalog);
  const review = tryReadJson(workDir, ARTIFACTS.review);
  const manifest = tryReadJson(workDir, ARTIFACTS.manifest);
  const recipe = loadRecipe(workDir);
  const audioIndex = tryReadJson(workDir, ARTIFACTS.audioIndex);
  const audioMetrics = computeAudioMetrics(audioIndex);

  const anchorMetrics = computeAnchorMetrics(spatialIndex ?? { scenes: [] });

  let speechWordCount = 0;
  let fillerRatio = 0;
  if (timelineIndex) {
    if (timelineIndex.stats?.totalWords != null) {
      const fillers = timelineIndex.stats.fillerWordCount ?? 0;
      speechWordCount = timelineIndex.stats.totalWords - fillers;
      fillerRatio = timelineIndex.stats.totalWords > 0
        ? Math.round((fillers / timelineIndex.stats.totalWords) * 1000) / 1000
        : 0;
    } else {
      speechWordCount = countSpeechWords(timelineIndex);
      fillerRatio = computeFillerRatio(timelineIndex);
    }
  }

  const topicCount = topicIndex?.topics?.length ?? 0;
  const topicMatchMetrics = computeTopicMatchMetrics(
    topicIndex,
    resolveBrollMatchThreshold(recipe, manifest),
  );
  const brollPoolSize = countBrollPool(clipRegistry);
  const creativeMomentCount = recipe?.creativeMoments?.length ?? 0;
  const retentionBeatCount = countRetentionBeats(recipe);
  const l1FieldsPresentPercent = computeL1FieldsPresentPercent(abstraction, timelineIndex);
  const dataQualityWarnings = [
    ...detectStubDataWarnings(timelineIndex, catalog, workDir),
    ...detectTopicIndexWarnings(topicIndex),
  ];

  let validationErrorCount = 0;
  let validationWarningCount = 0;
  let validation = null;

  if (recipe) {
    try {
      const parsed = EditRecipeV2Schema.parse(recipe);
      const wordIndexes = loadWordIndexes(workDir, catalog);
      const requiredFormats = parsed.batchContext?.requiredFormats ?? ["16:9", "9:16"];
      validation = validateRecipeV2(parsed, {
        requiredFormats,
        topicIndex: topicIndex ?? { topics: [] },
        spatialIndex: spatialIndex ?? { scenes: [] },
        wordIndexes,
        audioIndex,
      });
      validationErrorCount = validation.issues.filter((i) => i.severity === "error").length;
      validationWarningCount = validation.issues.filter((i) => i.severity === "warning").length;
    } catch {
      validationErrorCount = 1;
    }
  }

  const qualityGateFailures = collectQualityGateFailures({
    anchorCoveragePercent: anchorMetrics.anchorCoveragePercent,
    topicMatchRate: topicMatchMetrics.topicMatchRate,
    l1FieldsPresentPercent,
    validationErrorCount,
  });

  const needsHumanReview = Boolean(
    recipe?.needsHumanReview
    || review?.approved === false
    || qualityGateFailures.length > 0,
  );

  return {
    version: "1.0",
    batchId: timelineIndex?.batchId ?? catalog?.batchId ?? null,
    generatedAt: new Date().toISOString(),
    metrics: {
      ...anchorMetrics,
      ...audioMetrics,
      speechWordCount: Math.max(0, speechWordCount),
      fillerRatio,
      topicCount,
      ...topicMatchMetrics,
      brollPoolSize,
      creativeMomentCount,
      retentionBeatCount,
      validationErrorCount,
      validationWarningCount,
      l1FieldsPresentPercent,
      dataQualityWarnings,
      qualityGateFailures,
      needsHumanReview,
    },
    validation: validation
      ? { valid: validation.valid, issueCount: validation.issues.length }
      : null,
  };
}

export function formatBatchQualitySummary(report) {
  const m = report.metrics;
  const lines = [
    `Batch quality report — ${report.batchId ?? "unknown"}`,
    `  Anchor coverage: ${m.anchorCoveragePercent}% (${m.scenesWithAnchors}/${m.sceneCount} scenes)`,
    `  Face anchors: ${m.faceAnchorPercent}% (${m.scenesWithFace} scenes)`,
    `  Speech words: ${m.speechWordCount}, filler ratio: ${m.fillerRatio}`,
    `  Topics: ${m.topicCount} (match rate ${m.topicMatchRate}% @ ${m.topicMatchThreshold}, avg best score ${m.avgBestMatchScore})`,
    `  B-roll pool clips: ${m.brollPoolSize}`,
    `  L1 brollPotential populated: ${m.l1FieldsPresentPercent}%`,
  ];

  if (m.audioClipCount > 0) {
    lines.push(
      `  Audio: ${m.audioClipCount} clips, avg voice ${m.avgVoiceLufs ?? "n/a"} LUFS, ${m.totalBeatCount} beats, silence ${m.totalSilenceSec}s`,
    );
  }

  if (m.creativeMomentCount > 0 || m.retentionBeatCount > 0) {
    lines.push(
      `  Creative moments: ${m.creativeMomentCount}, retention beats: ${m.retentionBeatCount}`,
    );
  }

  if (m.validationErrorCount > 0 || m.validationWarningCount > 0) {
    lines.push(
      `  Validation: ${m.validationErrorCount} errors, ${m.validationWarningCount} warnings`,
    );
  }

  if (m.dataQualityWarnings?.length > 0) {
    lines.push(`  Data quality warnings: ${m.dataQualityWarnings.join(", ")}`);
  }

  if (m.qualityGateFailures?.length > 0) {
    lines.push(`  Quality gate failures: ${m.qualityGateFailures.join(", ")}`);
  }

  lines.push(`  Needs human review: ${m.needsHumanReview ? "yes" : "no"}`);
  return lines.join("\n");
}

export function writeBatchQualityReport(workDir) {
  const report = buildBatchQualityReport(workDir);
  const outPath = path.join(workDir, ARTIFACTS.batchQualityReport);
  writeJson(outPath, report);
  return { report, outPath, summary: formatBatchQualitySummary(report) };
}
