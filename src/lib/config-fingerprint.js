import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_ARTIFACT_VERSIONS } from "./clip-artifact-cache.js";
import { WHISPER_EDIT_PROMPT } from "./transcribe.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROFANITY_LIST_PATH = path.join(ROOT, "config", "profanity-pl.json");
const CONTENT_SAFETY_PATH = path.join(ROOT, "config", "safety", "content-safety-pl.json");

function whisperPromptFingerprint() {
  return createHash("sha256").update(WHISPER_EDIT_PROMPT).digest("hex").slice(0, 12);
}

function profanityListFingerprint() {
  const content = fs.readFileSync(PROFANITY_LIST_PATH, "utf8");
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function contentSafetyFingerprint() {
  const content = fs.readFileSync(CONTENT_SAFETY_PATH, "utf8");
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

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
        whisperPromptHash: whisperPromptFingerprint(),
        profanityListHash: profanityListFingerprint(),
        contentSafetyHash: contentSafetyFingerprint(),
        profanityPolicy: options.profanityPolicy ?? "bleep",
        profanitySubtitleMode: options.profanitySubtitleMode ?? "partial",
        brandSafety: options.brandSafety ?? null,
        expectedTerms: Array.isArray(options.expectedTerms) && options.expectedTerms.length > 0
          ? [...options.expectedTerms].map(String).sort()
          : null,
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
        minDurationSec: options.minDurationSec
          ?? Number.parseFloat(process.env.TWELVELABS_MIN_DURATION_SEC ?? "4"),
        proxyMaxBytes: options.proxyMaxBytes
          ?? Number.parseInt(process.env.TWELVELABS_PROXY_MAX_BYTES ?? String(180 * 1024 * 1024), 10),
        proxyHeight: options.proxyHeight
          ?? Number.parseInt(process.env.TWELVELABS_PROXY_HEIGHT ?? "720", 10),
        chunkDurationSec: options.chunkDurationSec
          ?? Number.parseFloat(process.env.TWELVELABS_CHUNK_DURATION_SEC ?? "300"),
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
