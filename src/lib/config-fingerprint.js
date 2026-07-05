import { createHash } from "node:crypto";
import { EXPECTED_ARTIFACT_VERSIONS } from "./clip-artifact-cache.js";

function stableFingerprint(parts) {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Deterministic config fingerprint for a pipeline analysis step.
 *
 * @param {string} step
 * @param {object} [options]
 * @returns {string}
 */
export function buildStepConfigFingerprint(step, options = {}) {
  const artifactVersion = EXPECTED_ARTIFACT_VERSIONS[step] ?? "0.0";

  switch (step) {
    case "words":
      return stableFingerprint({
        step,
        artifactVersion,
        whisperModel: process.env.OPENAI_WHISPER_MODEL ?? "whisper-1",
      });

    case "audioAnalysis":
      return stableFingerprint({
        step,
        artifactVersion,
        stub: options.stub === true,
      });

    case "keyframes":
      return stableFingerprint({
        step,
        artifactVersion,
        extractImages: options.extractImages !== false,
        maxFramesPerMin: options.maxFramesPerMin ?? null,
      });

    case "twelvelabs":
      return stableFingerprint({
        step,
        artifactVersion,
        useStub: options.useStub === true,
        twelvelabsLive: options.twelvelabsLive === true,
        indexId: process.env.TWELVELABS_INDEX_ID ?? null,
      });

    case "vision":
      return stableFingerprint({
        step,
        artifactVersion,
        stub: options.stub === true,
      });

    case "objects":
      return stableFingerprint({
        step,
        artifactVersion,
        stub: options.stub === true,
        enabled: options.enabled !== false,
      });

    case "faces":
      return stableFingerprint({
        step,
        artifactVersion,
        stub: options.stub === true,
      });

    default:
      return stableFingerprint({ step, artifactVersion });
  }
}
