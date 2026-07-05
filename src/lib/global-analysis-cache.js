import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getPipelineAnalysisVersion } from "./pipeline-analysis-version.js";

const DEFAULT_CACHE_ROOT = path.resolve(process.cwd(), "output", ".cache", "analysis");

export function resolveGlobalAnalysisCacheRoot(cacheRoot) {
  return cacheRoot ? path.resolve(cacheRoot) : DEFAULT_CACHE_ROOT;
}

/**
 * @param {{ disabled?: boolean }} [params]
 * @returns {boolean}
 */
export function isGlobalAnalysisCacheEnabled({ disabled } = {}) {
  if (disabled === true) {
    return false;
  }
  return process.env.DISABLE_GLOBAL_ANALYSIS_CACHE !== "1";
}

/**
 * @param {{ step: string, contentHash: string, configFingerprint: string }} params
 * @returns {string}
 */
export function buildAnalysisCacheKey({ step, contentHash, configFingerprint }) {
  const input = [
    getPipelineAnalysisVersion(),
    step,
    contentHash,
    configFingerprint,
  ].join("\0");

  return createHash("sha256").update(input).digest("hex");
}

/**
 * @param {string} step
 * @param {string} cacheKey
 * @param {string} [cacheRoot]
 * @returns {string}
 */
export function getGlobalCachePath(step, cacheKey, cacheRoot) {
  return path.join(resolveGlobalAnalysisCacheRoot(cacheRoot), step, `${cacheKey}.json`);
}

function isEnvelopeValid(envelope, { step, contentHash, configFingerprint }) {
  if (!envelope || typeof envelope !== "object") {
    return false;
  }

  return (
    envelope.pipelineAnalysisVersion === getPipelineAnalysisVersion()
    && envelope.step === step
    && envelope.contentHash === contentHash
    && envelope.configFingerprint === configFingerprint
    && envelope.data !== undefined
  );
}

/**
 * @param {{
 *   step: string,
 *   contentHash: string,
 *   configFingerprint: string,
 *   cacheRoot?: string,
 *   disabled?: boolean,
 * }} params
 * @returns {object|null}
 */
export function readGlobalAnalysisCache({
  step,
  contentHash,
  configFingerprint,
  cacheRoot,
  disabled,
}) {
  if (!isGlobalAnalysisCacheEnabled({ disabled })) {
    return null;
  }

  const cacheKey = buildAnalysisCacheKey({ step, contentHash, configFingerprint });
  const filePath = getGlobalCachePath(step, cacheKey, cacheRoot);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }

  if (!isEnvelopeValid(envelope, { step, contentHash, configFingerprint })) {
    return null;
  }

  return envelope;
}

/**
 * @param {{
 *   step: string,
 *   contentHash: string,
 *   configFingerprint: string,
 *   data: object,
 *   meta?: object,
 *   cacheRoot?: string,
 *   disabled?: boolean,
 * }} params
 * @returns {object|null}
 */
export function writeGlobalAnalysisCache({
  step,
  contentHash,
  configFingerprint,
  data,
  meta,
  cacheRoot,
  disabled,
}) {
  if (!isGlobalAnalysisCacheEnabled({ disabled })) {
    return null;
  }

  const cacheKey = buildAnalysisCacheKey({ step, contentHash, configFingerprint });
  const filePath = getGlobalCachePath(step, cacheKey, cacheRoot);
  const envelope = {
    pipelineAnalysisVersion: getPipelineAnalysisVersion(),
    step,
    contentHash,
    configFingerprint,
    cachedAt: new Date().toISOString(),
    data,
    ...(meta ? { meta } : {}),
  };

  const tmpPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);

  return envelope;
}
