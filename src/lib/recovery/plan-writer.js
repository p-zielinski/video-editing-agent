import fs from "node:fs";
import path from "node:path";
import { ARTIFACTS, readJson } from "../../pipeline/work-paths.js";
import { RecoveryPlanSchema } from "../../schemas/recovery-plan.js";
import { classifyError, failuresFromWaveErrors } from "./classify-error.js";
import { AnalysisWaveFailure, StepFailureError } from "./errors.js";
import { buildRecoveryFailure, buildRecommendedCommand } from "./templates.js";

export function readRecoveryPlan(workDir) {
  const planPath = path.join(workDir, ARTIFACTS.recoveryPlan);
  if (!fs.existsSync(planPath)) {
    return null;
  }
  return RecoveryPlanSchema.parse(readJson(planPath));
}

export function writeRecoveryPlan(workDir, plan) {
  const parsed = RecoveryPlanSchema.parse(plan);
  const planPath = path.join(workDir, ARTIFACTS.recoveryPlan);
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

export function clearRecoveryPlan(workDir) {
  const planPath = path.join(workDir, ARTIFACTS.recoveryPlan);
  if (fs.existsSync(planPath)) {
    fs.unlinkSync(planPath);
  }
}

function buildFailuresFromError(error, { batchId, step }) {
  if (error instanceof AnalysisWaveFailure || (error instanceof StepFailureError && error.failures?.length)) {
    return error.failures.map((entry) => buildRecoveryFailure({
      code: entry.code,
      step: error.step ?? step,
      batchId,
      message: entry.message,
      cause: entry.cause ?? null,
      scope: entry.clipId ? { clipId: entry.clipId } : (entry.scope ?? null),
      forceRequired: entry.forceRequired ?? false,
      artifactsToInvalidate: entry.artifactsToInvalidate ?? null,
      prerequisites: entry.prerequisites ?? null,
    }));
  }

  const classified = classifyError(error, { step, batchId });
  return [buildRecoveryFailure({
    code: classified.code,
    step: classified.step ?? step,
    batchId,
    message: classified.message,
    cause: classified.cause ?? null,
    scope: classified.scope ?? null,
    prerequisites: classified.prerequisites ?? null,
  })];
}

export function buildRecoveryPlan({
  error,
  batchId,
  workDir,
  ledger = null,
  step = null,
}) {
  const failedStep = error?.step ?? step ?? ledger?.getState()?.currentStep ?? null;
  const failures = buildFailuresFromError(error, { batchId, step: failedStep });
  const plan = RecoveryPlanSchema.parse({
    version: "1.0",
    batchId,
    pipelineRunId: ledger?.getState()?.pipelineRunId ?? "unknown",
    status: "action_required",
    failedStep,
    createdAt: new Date().toISOString(),
    failures,
    recommendedCommand: buildRecommendedCommand(failures, batchId),
  });
  return plan;
}

export function buildAnalysisWaveFailure(step, waveErrors, batchId) {
  const entries = failuresFromWaveErrors(step, waveErrors, batchId);
  const clipIds = entries.map((e) => e.clipId).filter(Boolean);
  const message = clipIds.length > 0
    ? `${step}: ${clipIds.length} klip(ów) nie powiodło się (${clipIds.join(", ")})`
    : `${step}: fala analizy nie powiodła się`;
  return new AnalysisWaveFailure(message, {
    step,
    failures: entries.map((entry) => ({
      ...entry,
      scope: entry.clipId ? { clipId: entry.clipId } : undefined,
    })),
  });
}

export function formatRecoveryPlanReport(plan, { workDir = null } = {}) {
  const lines = [];
  lines.push("=== Recovery plan ===");
  if (workDir) {
    lines.push(`Artefakt: ${path.join(workDir, ARTIFACTS.recoveryPlan)}`);
  }
  lines.push(`Status: ${plan.status}`);
  lines.push(`Failed step: ${plan.failedStep ?? "unknown"}`);
  lines.push(`Recommended: ${plan.recommendedCommand}`);
  for (const [index, failure] of plan.failures.entries()) {
    lines.push("");
    lines.push(`[${index + 1}] ${failure.code} (${failure.step})`);
    lines.push(`  ${failure.message}`);
    if (failure.scope?.clipId) {
      lines.push(`  clip: ${failure.scope.clipId}`);
    }
    if (failure.prerequisites?.length) {
      lines.push("  Prerequisites:");
      for (const prereq of failure.prerequisites) {
        lines.push(`    - ${prereq}`);
      }
    }
    lines.push(`  Command: ${failure.recoveryCommand}`);
  }
  return lines.join("\n");
}
