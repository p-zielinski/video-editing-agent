import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, ARTIFACTS } from "../pipeline/work-paths.js";

export function parseOpenAIUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
  const totalTokens = Number(
    usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens,
  );
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}

export function createUsageRecorder(tracker, step) {
  if (!tracker) {
    return undefined;
  }
  return ({ model, usage, requestedModel, callId }) => {
    tracker.record({
      step,
      model,
      usage,
      requestedModel,
      callId,
    });
  };
}

export function flushGptUsageIfNeeded(workDir, tracker, { batchId, log } = {}) {
  const unflushed = tracker.getUnflushedRecords?.() ?? tracker.getRecords();
  if (!tracker || unflushed.length === 0) {
    return null;
  }
  const { outPath } = writeGptUsage(workDir, tracker, { batchId });
  if (typeof log?.detail === "function") {
    log.detail(`GPT usage: ${outPath}`);
  }
  return outPath;
}

export function buildAgentChatContext({
  gptUsageTracker,
  dailyQuotaTracker,
  batchId,
  step,
  cacheKey,
  workDir,
}) {
  return {
    onUsage: createUsageRecorder(gptUsageTracker, step),
    quotaTracker: dailyQuotaTracker ?? null,
    batchId: batchId ?? null,
    step: step ?? null,
    cacheKey: cacheKey ?? null,
    workDir: workDir ?? null,
  };
}

export function createGptUsageTracker() {
  /** @type {Array<{ step: string, model: string, usage: object, recordedAt: string, callId?: string, requestedModel?: string }>} */
  const records = [];
  let flushedCount = 0;

  return {
    record({ step, model, usage, callId, requestedModel }) {
      const parsed = parseOpenAIUsage(usage);
      if (!parsed) {
        return;
      }
      records.push({
        step,
        model: model ?? "unknown",
        usage: parsed,
        recordedAt: new Date().toISOString(),
        ...(callId ? { callId } : {}),
        ...(requestedModel ? { requestedModel } : {}),
      });
    },
    getRecords() {
      return [...records];
    },
    getUnflushedRecords() {
      return records.slice(flushedCount);
    },
    markFlushed() {
      flushedCount = records.length;
    },
    summary() {
      return summarizeGptUsageRecords(records);
    },
  };
}

export function summarizeGptUsageRecords(records) {
  /** @type {Record<string, { calls: number, promptTokens: number, completionTokens: number, totalTokens: number, models: Set<string> }>} */
  const byStep = {};
  const totals = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  for (const record of records) {
    const usage = record.usage ?? {};
    const step = record.step ?? "unknown";
    byStep[step] = byStep[step] ?? {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      models: new Set(),
    };
    const bucket = byStep[step];
    bucket.calls += 1;
    bucket.promptTokens += usage.promptTokens ?? 0;
    bucket.completionTokens += usage.completionTokens ?? 0;
    bucket.totalTokens += usage.totalTokens ?? 0;
    bucket.models.add(record.model ?? "unknown");

    totals.calls += 1;
    totals.promptTokens += usage.promptTokens ?? 0;
    totals.completionTokens += usage.completionTokens ?? 0;
    totals.totalTokens += usage.totalTokens ?? 0;
  }

  const steps = {};
  for (const [step, bucket] of Object.entries(byStep)) {
    steps[step] = {
      calls: bucket.calls,
      promptTokens: bucket.promptTokens,
      completionTokens: bucket.completionTokens,
      totalTokens: bucket.totalTokens,
      models: [...bucket.models].sort(),
    };
  }

  return { steps, totals };
}

export function summarizeGptUsageByModel(records) {
  /** @type {Record<string, { calls: number, promptTokens: number, completionTokens: number, totalTokens: number, models: string[] }>} */
  const byModel = {};
  for (const record of records) {
    const model = record.model ?? "unknown";
    const usage = record.usage ?? {};
    byModel[model] = byModel[model] ?? {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const bucket = byModel[model];
    bucket.calls += 1;
    bucket.promptTokens += usage.promptTokens ?? 0;
    bucket.completionTokens += usage.completionTokens ?? 0;
    bucket.totalTokens += usage.totalTokens ?? 0;
  }
  return byModel;
}

export function mergeGptUsageDocuments(existing, incoming, { batchId } = {}) {
  const existingRecords = existing?.records ?? [];
  const incomingRecords = incoming?.records ?? [];
  const records = [...existingRecords, ...incomingRecords];
  return {
    version: "1.0",
    batchId: batchId ?? incoming?.batchId ?? existing?.batchId ?? null,
    updatedAt: new Date().toISOString(),
    records,
    ...summarizeGptUsageRecords(records),
  };
}

export function writeGptUsage(workDir, tracker, { batchId } = {}) {
  const outPath = path.join(workDir, ARTIFACTS.gptUsage);
  const deltaRecords = tracker.getUnflushedRecords?.() ?? tracker.getRecords();
  if (deltaRecords.length === 0) {
    return { outPath, document: null };
  }

  const incoming = {
    batchId: batchId ?? null,
    records: deltaRecords,
    ...summarizeGptUsageRecords(deltaRecords),
  };

  let document = incoming;
  if (fs.existsSync(outPath)) {
    try {
      const existing = readJson(outPath);
      document = mergeGptUsageDocuments(existing, incoming, { batchId });
    } catch {
      document = {
        version: "1.0",
        updatedAt: new Date().toISOString(),
        ...incoming,
      };
    }
  } else {
    document = {
      version: "1.0",
      updatedAt: new Date().toISOString(),
      ...incoming,
    };
  }

  writeJson(outPath, document);
  tracker.markFlushed?.();
  return { outPath, document };
}

export function readGptUsageSummary(workDir) {
  const filePath = path.join(workDir, ARTIFACTS.gptUsage);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const data = readJson(filePath);
    const { steps, totals } = summarizeGptUsageRecords(data.records ?? []);
    return { steps, totals, updatedAt: data.updatedAt ?? null };
  } catch {
    return null;
  }
}
