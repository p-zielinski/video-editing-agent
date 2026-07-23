import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";
import { resolveWorkDir } from "../pipeline/work-paths.js";

const log = createLogger("llm-cache");
const CACHE_VERSION = "1.0";
const CACHE_DIR_NAME = "llm-cache";

export function isLlmReuseEnabled(env = process.env) {
  return env.LLM_REUSE_CACHE === "1";
}

export function sanitizeCacheSegment(value) {
  return String(value ?? "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

export function buildLlmCacheFileName({ step, role, cacheKey }) {
  const parts = [
    sanitizeCacheSegment(step),
    sanitizeCacheSegment(role),
  ];
  if (cacheKey) {
    parts.push(sanitizeCacheSegment(cacheKey));
  }
  return `${parts.join("__")}.json`;
}

export function resolveLlmCacheDir(batchId, workDir = null) {
  const base = workDir ?? resolveWorkDir(batchId);
  return path.join(base, CACHE_DIR_NAME);
}

/**
 * Delete abstract-step summarizer L1/L2 LLM response caches for a batch workdir.
 * Does not touch director / critic / L3 caches.
 * @param {string} workDir
 * @returns {string[]} deleted file names
 */
export function clearSummarizerAbstractLlmCache(workDir) {
  if (!workDir) {
    return [];
  }
  const cacheDir = path.join(workDir, CACHE_DIR_NAME);
  if (!fs.existsSync(cacheDir)) {
    return [];
  }

  const deleted = [];
  for (const name of fs.readdirSync(cacheDir)) {
    const isL1 = name.startsWith("abstract__summarizerL1");
    const isL2 = name.startsWith("abstract__summarizerL2");
    if (!(isL1 || isL2) || !name.endsWith(".json")) {
      continue;
    }
    fs.unlinkSync(path.join(cacheDir, name));
    deleted.push(name);
  }
  if (deleted.length > 0) {
    log.log(`Cleared ${deleted.length} summarizer L1/L2 LLM cache file(s)`);
  }
  return deleted;
}

export function resolveLlmCachePath({
  batchId,
  workDir = null,
  step,
  role,
  cacheKey,
}) {
  return path.join(
    resolveLlmCacheDir(batchId, workDir),
    buildLlmCacheFileName({ step, role, cacheKey }),
  );
}

export function tryReadLlmResponseCache({
  batchId,
  workDir = null,
  step,
  role,
  cacheKey,
  env = process.env,
} = {}) {
  if (!isLlmReuseEnabled(env)) {
    return null;
  }
  if (!batchId || !step) {
    return null;
  }

  const filePath = resolveLlmCachePath({ batchId, workDir, step, role, cacheKey });
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!payload?.response) {
      return null;
    }
    log.detail(`LLM cache hit: ${filePath}`);
    return payload;
  } catch {
    return null;
  }
}

export function writeLlmResponseCache({
  batchId,
  workDir = null,
  step,
  role,
  cacheKey,
  response,
  model = null,
  callId = null,
}) {
  if (!batchId || !step) {
    return null;
  }

  const filePath = resolveLlmCachePath({ batchId, workDir, step, role, cacheKey });
  const payload = {
    version: CACHE_VERSION,
    batchId,
    step,
    role: role ?? null,
    cacheKey: cacheKey ?? null,
    model,
    callId,
    recordedAt: new Date().toISOString(),
    response,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

export function persistLlmSchemaRejection({
  batchId,
  workDir = null,
  step,
  role,
  cacheKey,
  raw,
  zodError,
}) {
  const cachePath = writeLlmResponseCache({
    batchId,
    workDir,
    step,
    role,
    cacheKey,
    response: raw,
  });
  if (!cachePath) {
    return null;
  }

  const rejectedPath = cachePath.replace(/\.json$/, "__rejected.json");
  const payload = {
    version: CACHE_VERSION,
    batchId,
    step,
    role: role ?? null,
    cacheKey: cacheKey ?? null,
    cachePath,
    recordedAt: new Date().toISOString(),
    issues: zodError?.issues ?? [],
  };
  fs.writeFileSync(rejectedPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return rejectedPath;
}

export function parseAgentSchema(schema, raw, {
  batchId,
  workDir = null,
  step,
  role,
  cacheKey,
}) {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  const rejectionPath = persistLlmSchemaRejection({
    batchId,
    workDir,
    step,
    role,
    cacheKey,
    raw,
    zodError: result.error,
  });
  if (rejectionPath) {
    const cacheHintPath = resolveLlmCachePath({
      batchId,
      workDir,
      step,
      role,
      cacheKey,
    });
    result.error.llmRejectionPath = rejectionPath;
    result.error.llmCacheHint = `Edytuj pole response w ${cacheHintPath}, potem wznów z --reuse-llm-cache`;
  }
  throw result.error;
}
