import { ERROR_CODES } from "./error-codes.js";
import { AnalysisWaveFailure, AudioEnhancementProviderError, StepFailureError } from "./errors.js";

function extractCause(error) {
  if (!error) {
    return null;
  }
  if (error.cause instanceof Error) {
    return error.cause.message;
  }
  if (typeof error.cause === "string") {
    return error.cause;
  }
  return null;
}

function clipErrorCodeForStep(step) {
  switch (step) {
    case "transcribe":
      return ERROR_CODES.TRANSCRIBE_CLIP_FAILED;
    case "audio_analysis":
      return ERROR_CODES.AUDIO_ANALYSIS_CLIP_FAILED;
    case "keyframes":
      return ERROR_CODES.KEYFRAMES_CLIP_FAILED;
    case "twelvelabs":
      return ERROR_CODES.TWELVELABS_CLIP_FAILED;
    case "vision":
      return ERROR_CODES.VISION_CLIP_FAILED;
    case "objects":
      return ERROR_CODES.OBJECTS_CLIP_FAILED;
    case "audio_enhancement":
      return ERROR_CODES.AUDIO_ENHANCEMENT_CLIP_FAILED;
    default:
      return ERROR_CODES.PIPELINE_STEP_FAILED;
  }
}

export function classifyError(error, { step = null, batchId = null } = {}) {
  if (error instanceof AnalysisWaveFailure) {
    return {
      code: error.code,
      step: error.step ?? step,
      message: error.message,
      cause: extractCause(error),
      failures: error.failures,
    };
  }

  if (error instanceof StepFailureError) {
    return {
      code: error.code,
      step: error.step ?? step,
      message: error.message,
      cause: extractCause(error),
      scope: error.scope ?? undefined,
      failures: error.failures,
    };
  }

  if (error instanceof AudioEnhancementProviderError) {
    return {
      code: error.code,
      step: step ?? "audio_enhancement",
      message: error.message,
      cause: error.stderr ?? extractCause(error),
      scope: error.clipId ? { clipId: error.clipId } : undefined,
      recoveryHint: error.recoveryHint ?? undefined,
    };
  }

  if (error?.code === "RECIPE_VALIDATION_FAILED") {
    return {
      code: ERROR_CODES.RECIPE_VALIDATION_FAILED,
      step: step ?? "review",
      message: error.message,
      cause: extractCause(error),
      validation: error.validation ?? undefined,
    };
  }

  if (error?.code === "RECIPE_REVIEW_NOT_APPROVED") {
    return {
      code: ERROR_CODES.RECIPE_REVIEW_NOT_APPROVED,
      step: step ?? "review",
      message: error.message,
      cause: extractCause(error),
    };
  }

  if (error?.message?.includes("Python preflight failed")) {
    return {
      code: ERROR_CODES.PYTHON_PREFLIGHT_FAILED,
      step: step ?? "vision",
      message: error.message,
      cause: extractCause(error),
    };
  }

  if (error?.message?.includes("Krok ingest wymaga")) {
    return {
      code: ERROR_CODES.INGEST_INPUT_MISSING,
      step: "ingest",
      message: error.message,
      cause: extractCause(error),
    };
  }

  return {
    code: error?.code ?? ERROR_CODES.PIPELINE_STEP_FAILED,
    step: step ?? error?.step ?? null,
    message: error instanceof Error ? error.message : String(error),
    cause: extractCause(error),
    scope: error?.scope ?? undefined,
  };
}

export function failuresFromWaveErrors(step, waveErrors, batchId) {
  return waveErrors.map(({ item, error }) => ({
    clipId: item?.clipId ?? null,
    code: clipErrorCodeForStep(step),
    message: error instanceof Error ? error.message : String(error),
    cause: extractCause(error),
  }));
}
