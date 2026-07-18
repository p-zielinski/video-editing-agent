import { ERROR_CODES } from "./error-codes.js";

export class StepFailureError extends Error {
  constructor(message, {
    code = ERROR_CODES.PIPELINE_STEP_FAILED,
    step,
    scope = null,
    failures = [],
    cause = null,
  } = {}) {
    super(message, { cause });
    this.name = "StepFailureError";
    this.code = code;
    this.step = step;
    this.scope = scope;
    this.failures = failures;
  }
}

export class AnalysisWaveFailure extends StepFailureError {
  constructor(message, { step, failures = [], cause = null } = {}) {
    super(message, {
      code: ERROR_CODES.ANALYSIS_WAVE_FAILED,
      step,
      failures,
      cause,
    });
    this.name = "AnalysisWaveFailure";
  }
}

export class AudioEnhancementProviderError extends Error {
  constructor(message, {
    code = ERROR_CODES.AUDIO_ENH_PROVIDER_FAILED,
    provider,
    stderr = null,
    exitCode = null,
    recoveryHint = null,
    clipId = null,
  } = {}) {
    super(message);
    this.name = "AudioEnhancementProviderError";
    this.code = code;
    this.provider = provider;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.recoveryHint = recoveryHint;
    this.clipId = clipId;
  }
}
