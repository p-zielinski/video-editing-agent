import {
  buildRecoveryPlan,
  clearRecoveryPlan,
  ExecutionLedger,
  writeRecoveryPlan,
} from "./index.js";

/**
 * Run a pipeline step with execution ledger tracking.
 *
 * @param {ExecutionLedger} ledger
 * @param {string} step
 * @param {() => Promise<unknown>} fn
 */
export async function runTrackedStep(ledger, step, fn) {
  ledger.beginStep(step);
  try {
    const result = await fn();
    ledger.finishStep(step, "succeeded");
    return result;
  } catch (error) {
    ledger.failStep(step, error);
    throw error;
  }
}

export function createPipelineLedger(workDir, batchId) {
  const ledger = new ExecutionLedger(workDir, batchId);
  ledger.beginRun();
  return ledger;
}

export function finalizePipelineSuccess(ledger, workDir) {
  ledger.finishRun("succeeded");
  clearRecoveryPlan(workDir);
}

export function persistPipelineFailure({
  error,
  batchId,
  workDir,
  ledger,
  step,
}) {
  const plan = buildRecoveryPlan({
    error,
    batchId,
    workDir,
    ledger,
    step,
  });
  writeRecoveryPlan(workDir, plan);
  return plan;
}
