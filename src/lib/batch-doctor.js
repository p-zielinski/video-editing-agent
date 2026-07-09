import fs from "node:fs";
import path from "node:path";
import {
  ARTIFACTS,
  PIPELINE_STEPS,
  readJson,
  resolveWorkDir,
  artifactExists,
} from "../pipeline/work-paths.js";
import {
  CLIP_ARTIFACT_PATTERNS,
  isArtifactStale,
  listClipArtifactPaths,
  resolveInputPaths,
} from "../pipeline/artifact-deps.js";
import { readRecipeProvenance } from "./recipe-provenance.js";
import { evaluateBriefMetricsWarnings } from "./brief-metrics.js";
import { shouldUseSuperDirector } from "./segment-catalog.js";
import { readGptUsageSummary } from "./gpt-usage-log.js";

const STEP_ARTIFACT_CHECKS = [
  { step: "ingest", artifacts: [ARTIFACTS.manifest, ARTIFACTS.sceneCatalog] },
  { step: "index", artifacts: [ARTIFACTS.timelineIndex] },
  { step: "clip_profile", artifacts: [ARTIFACTS.clipRegistry] },
  { step: "abstract", artifacts: [ARTIFACTS.abstraction] },
  { step: "topic_index", artifacts: [ARTIFACTS.topicIndex] },
  { step: "spatial_index", artifacts: [ARTIFACTS.spatialIndex] },
  { step: "direct", artifacts: [ARTIFACTS.recipeDraft] },
  { step: "review", artifacts: [ARTIFACTS.review, ARTIFACTS.recipeFinal] },
  { step: "thumbnails", artifacts: [ARTIFACTS.thumbnailPlan, ARTIFACTS.thumbnailReview] },
];

const KNOWN_BATCH_ARTIFACTS = [
  ARTIFACTS.manifest,
  ARTIFACTS.sceneCatalog,
  ARTIFACTS.timelineIndex,
  ARTIFACTS.clipRegistry,
  ARTIFACTS.topicIndex,
  ARTIFACTS.spatialIndex,
  ARTIFACTS.audioIndex,
  ARTIFACTS.aiVideo,
  ARTIFACTS.abstraction,
  ARTIFACTS.recipeDraft,
  ARTIFACTS.review,
  ARTIFACTS.recipeFinal,
  ARTIFACTS.batchQualityReport,
  ARTIFACTS.thumbnailPlan,
  ARTIFACTS.thumbnailReview,
  ARTIFACTS.renderManifest,
  ARTIFACTS.recipeProvenance,
  ARTIFACTS.gptUsage,
];

function tryReadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function fileMtimeMs(filePath) {
  return fs.statSync(filePath).mtimeMs;
}

function listStaleUpstream(workDir, artifactName) {
  const artifactPath = path.join(workDir, artifactName);
  if (!fs.existsSync(artifactPath)) {
    return [];
  }
  const artifactMtime = fileMtimeMs(artifactPath);
  const stale = [];
  for (const inputPath of resolveInputPaths(workDir, artifactName)) {
    if (fileMtimeMs(inputPath) > artifactMtime) {
      stale.push(path.basename(inputPath));
    }
  }
  return stale;
}

function listWorkDirArtifacts(workDir) {
  if (!fs.existsSync(workDir)) {
    return [];
  }
  return fs.readdirSync(workDir).filter((name) => name.endsWith(".json"));
}

function clipArtifactsComplete(workDir, patternKey) {
  const catalog = tryReadJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const clipIds = (catalog?.clips ?? []).map((clip) => clip.clipId);
  if (clipIds.length === 0) {
    return listClipArtifactPaths(workDir, patternKey).length > 0;
  }
  const prefix = patternKey.slice(0, -1);
  return clipIds.every((clipId) => fs.existsSync(path.join(workDir, `${prefix}${clipId}.json`)));
}

function resolveLastCompletedStep(workDir) {
  let lastCompleted = null;
  for (const check of STEP_ARTIFACT_CHECKS) {
    const complete = check.artifacts.every((artifact) => artifactExists(workDir, artifact));
    if (complete) {
      lastCompleted = check.step;
    }
  }
  if (lastCompleted === "ingest" && clipArtifactsComplete(workDir, CLIP_ARTIFACT_PATTERNS.words)) {
  // advance through analysis markers when present
  }
  if (clipArtifactsComplete(workDir, CLIP_ARTIFACT_PATTERNS.words)) {
    lastCompleted = lastCompleted && PIPELINE_STEPS.indexOf(lastCompleted) >= PIPELINE_STEPS.indexOf("transcribe")
      ? lastCompleted
      : "transcribe";
  }
  return lastCompleted;
}

function missingArtifactsForStep(workDir, step) {
  const check = STEP_ARTIFACT_CHECKS.find((entry) => entry.step === step);
  if (!check) {
    return [];
  }
  return check.artifacts.filter((artifact) => !artifactExists(workDir, artifact));
}

function collectStaleArtifacts(workDir) {
  const stale = [];
  const names = new Set([
    ...KNOWN_BATCH_ARTIFACTS,
    ...listWorkDirArtifacts(workDir),
  ]);

  for (const name of names) {
    if (!artifactExists(workDir, name)) {
      continue;
    }
    if (!isArtifactStale(workDir, name)) {
      continue;
    }
    stale.push({
      artifact: name,
      upstream: listStaleUpstream(workDir, name),
    });
  }

  for (const patternKey of Object.values(CLIP_ARTIFACT_PATTERNS)) {
    for (const filePath of listClipArtifactPaths(workDir, patternKey)) {
      const name = path.basename(filePath);
      if (!isArtifactStale(workDir, name)) {
        continue;
      }
      stale.push({
        artifact: name,
        upstream: listStaleUpstream(workDir, name),
      });
    }
  }

  return stale;
}

function analyzeRecipeState(workDir) {
  const issues = [];
  const draftPath = path.join(workDir, ARTIFACTS.recipeDraft);
  const finalPath = path.join(workDir, ARTIFACTS.recipeFinal);
  const draftExists = fs.existsSync(draftPath);
  const finalExists = fs.existsSync(finalPath);
  const draft = draftExists ? tryReadJson(draftPath) : null;
  const finalRecipe = finalExists ? tryReadJson(finalPath) : null;
  const provenance = readRecipeProvenance(workDir);

  const state = {
    draftExists,
    finalExists,
    needsHumanReview: finalRecipe?.needsHumanReview ?? null,
    reviewNotes: finalRecipe?.reviewNotes ?? null,
    draftHash: provenance?.afterDirector?.hash ?? null,
    finalHash: provenance?.afterReview?.hash ?? null,
  };

  if (draftExists && !finalExists) {
    issues.push({
      severity: "warning",
      code: "RECIPE_FINAL_MISSING",
      message: "Istnieje draft receptury, brak finalnej (09-edit-recipe-final.json)",
    });
  }

  if (finalExists && finalRecipe?.needsHumanReview === true) {
    issues.push({
      severity: "warning",
      code: "NEEDS_HUMAN_REVIEW",
      message: finalRecipe.reviewNotes
        ? `Finalna receptura wymaga przeglądu człowieka: ${finalRecipe.reviewNotes}`
        : "Finalna receptura ma needsHumanReview=true",
    });
  }

  if (draftExists && finalExists && provenance?.afterDirector?.hash && provenance?.afterReview?.hash) {
    if (provenance.afterDirector.hash !== provenance.afterReview.hash) {
      state.reviewChangedRecipe = true;
    }
  }

  return { state, issues };
}

function analyzeSuperPath(workDir) {
  const issues = [];
  const timelineIndex = tryReadJson(path.join(workDir, ARTIFACTS.timelineIndex));
  const abstraction = tryReadJson(path.join(workDir, ARTIFACTS.abstraction));
  const manifest = tryReadJson(path.join(workDir, ARTIFACTS.manifest));
  const batchContext = manifest?.batchContext ?? {};
  const superPath = timelineIndex && abstraction
    ? shouldUseSuperDirector(timelineIndex, abstraction, batchContext)
    : false;

  const provenance = readRecipeProvenance(workDir);
  const state = {
    superPath,
    stitchValidation: provenance?.stitchValidation ?? null,
    superCriticReview: provenance?.superCriticReview ?? null,
  };

  if (!superPath || !artifactExists(workDir, ARTIFACTS.recipeDraft)) {
    return { state, issues };
  }

  if (!provenance?.stitchValidation) {
    issues.push({
      severity: "warning",
      code: "SUPER_STITCH_VALIDATION_MISSING",
      message: "Ścieżka super-director bez stitchValidation w provenance",
    });
  }

  if (!provenance?.superCriticReview) {
    issues.push({
      severity: "warning",
      code: "SUPER_CRITIC_REVIEW_MISSING",
      message: "Ścieżka super-director bez superCriticReview w provenance",
    });
  } else if (provenance.superCriticReview.approved === false) {
    issues.push({
      severity: "warning",
      code: "SUPER_CRITIC_NOT_APPROVED",
      message: provenance.superCriticReview.summary
        ? `Super-critic nie zatwierdził receptury: ${provenance.superCriticReview.summary}`
        : "Super-critic nie zatwierdził receptury (approved=false)",
    });
  }

  return { state, issues };
}

function analyzeDirectorMetrics(workDir) {
  const issues = [];
  const timelineIndex = tryReadJson(path.join(workDir, ARTIFACTS.timelineIndex));
  const provenance = readRecipeProvenance(workDir);
  const sceneCount = timelineIndex?.scenes?.length ?? 0;
  const briefSceneMapCoverage = provenance?.directorMetrics?.briefSceneMapCoverage;

  if (
    briefSceneMapCoverage != null
    && briefSceneMapCoverage < 0.5
    && sceneCount > 30
  ) {
    issues.push({
      severity: "warning",
      code: "DIRECTOR_SCENE_MAP_COVERAGE_LOW",
      message: `Pokrycie mapy scen briefSceneMapCoverage=${briefSceneMapCoverage} przy ${sceneCount} scenach (próg 0.5)`,
    });
  }

  const briefMetrics = provenance?.directorMetrics?.briefMetrics;
  for (const warning of evaluateBriefMetricsWarnings(briefMetrics)) {
    issues.push({
      severity: "warning",
      code: warning.code,
      message: warning.code === "BRIEF_PAYLOAD_TOTAL_LARGE"
        ? `Łączny rozmiar briefów directora ~${warning.estimatedTokens} tokenów (${warning.callCount} wywołań GPT)`
        : `Duży brief GPT (${warning.task}${warning.segmentId ? `/${warning.segmentId}` : ""}): ~${warning.estimatedTokens} tokenów`,
    });
  }

  return { issues };
}

export function diagnoseBatch(workDir) {
  const issues = [];
  const absoluteWorkDir = path.resolve(workDir);

  if (!fs.existsSync(absoluteWorkDir)) {
    return {
      workDir: absoluteWorkDir,
      ok: false,
      criticalCount: 1,
      warningCount: 0,
      lastCompletedStep: null,
      issues: [{
        severity: "critical",
        code: "WORK_DIR_MISSING",
        message: `Katalog roboczy nie istnieje: ${absoluteWorkDir}`,
      }],
      gptUsage: null,
    };
  }

  if (!artifactExists(absoluteWorkDir, ARTIFACTS.manifest)) {
    issues.push({
      severity: "critical",
      code: "MANIFEST_MISSING",
      message: `Brak ${ARTIFACTS.manifest}`,
    });
  }

  const manifest = tryReadJson(path.join(absoluteWorkDir, ARTIFACTS.manifest));
  const lastCompletedStep = resolveLastCompletedStep(absoluteWorkDir);
  const nextStepIndex = lastCompletedStep
    ? PIPELINE_STEPS.indexOf(lastCompletedStep) + 1
    : 0;
  const nextStep = PIPELINE_STEPS[nextStepIndex] ?? null;

  if (lastCompletedStep) {
    const missing = missingArtifactsForStep(absoluteWorkDir, lastCompletedStep);
    for (const artifact of missing) {
      issues.push({
        severity: "critical",
        code: "STEP_ARTIFACT_MISSING",
        message: `Dla kroku ${lastCompletedStep} brakuje artefaktu ${artifact}`,
      });
    }
  }

  const staleArtifacts = collectStaleArtifacts(absoluteWorkDir);
  for (const entry of staleArtifacts) {
    issues.push({
      severity: "warning",
      code: "STALE_ARTIFACT",
      message: entry.upstream.length > 0
        ? `${entry.artifact} jest nieaktualny względem: ${entry.upstream.join(", ")}`
        : `${entry.artifact} jest nieaktualny (brak upstream w grafie zależności)`,
    });
  }

  const recipeAnalysis = analyzeRecipeState(absoluteWorkDir);
  issues.push(...recipeAnalysis.issues);

  const superAnalysis = analyzeSuperPath(absoluteWorkDir);
  issues.push(...superAnalysis.issues);

  const directorAnalysis = analyzeDirectorMetrics(absoluteWorkDir);
  issues.push(...directorAnalysis.issues);

  const gptUsage = readGptUsageSummary(absoluteWorkDir);

  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;

  return {
    workDir: absoluteWorkDir,
    batchId: manifest?.batchId ?? path.basename(absoluteWorkDir),
    ok: criticalCount === 0,
    criticalCount,
    warningCount,
    lastCompletedStep,
    nextStep,
    manifestPresent: Boolean(manifest),
    staleArtifacts,
    recipe: recipeAnalysis.state,
    superPath: superAnalysis.state,
    gptUsage,
    issues,
  };
}

export function formatBatchDoctorReport(diagnosis) {
  const lines = [];
  lines.push(`Batch doctor: ${diagnosis.batchId ?? path.basename(diagnosis.workDir)}`);
  lines.push(`Work dir: ${diagnosis.workDir}`);
  lines.push(`Status: ${diagnosis.ok ? "OK" : "PROBLEMY"} (${diagnosis.criticalCount} krytycznych, ${diagnosis.warningCount} ostrzeżeń)`);

  if (diagnosis.lastCompletedStep) {
    lines.push(`Ostatni ukończony krok: ${diagnosis.lastCompletedStep}`);
    if (diagnosis.nextStep) {
      lines.push(`Następny krok: ${diagnosis.nextStep}`);
    }
  } else {
    lines.push("Ostatni ukończony krok: brak");
  }

  if (diagnosis.recipe) {
    const recipeBits = [];
    if (diagnosis.recipe.draftExists) {
      recipeBits.push("draft");
    }
    if (diagnosis.recipe.finalExists) {
      recipeBits.push("final");
    }
    if (recipeBits.length > 0) {
      lines.push(`Receptura: ${recipeBits.join(" + ")}`);
    }
    if (diagnosis.recipe.needsHumanReview === true) {
      lines.push("needsHumanReview: true");
    }
  }

  if (diagnosis.superPath?.superPath) {
    lines.push("Ścieżka: super-director");
    lines.push(`stitchValidation: ${diagnosis.superPath.stitchValidation ? "tak" : "brak"}`);
    lines.push(`superCriticReview: ${diagnosis.superPath.superCriticReview ? "tak" : "brak"}`);
  }

  if (diagnosis.gptUsage?.totals?.calls) {
    const { totals } = diagnosis.gptUsage;
    lines.push(
      `GPT usage: ${totals.calls} wywołań, `
      + `${totals.promptTokens} prompt + ${totals.completionTokens} completion tokens`,
    );
  }

  if (diagnosis.issues.length > 0) {
    lines.push("");
    lines.push("Problemy:");
    for (const issue of diagnosis.issues) {
      const label = issue.severity === "critical" ? "KRYTYCZNE" : "OSTRZEŻENIE";
      lines.push(`  [${label}] ${issue.code}: ${issue.message}`);
    }
  } else {
    lines.push("");
    lines.push("Brak problemów.");
  }

  return lines.join("\n");
}

export function runBatchDoctor({ batchId, workDir, baseDir = "output/.work" } = {}) {
  const resolvedWorkDir = workDir ?? resolveWorkDir(batchId, baseDir);
  const diagnosis = diagnoseBatch(resolvedWorkDir);
  return {
    diagnosis,
    report: formatBatchDoctorReport(diagnosis),
    exitCode: diagnosis.ok ? 0 : 1,
  };
}
