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
  return ({ model, usage }) => {
    tracker.record({ step, model, usage });
  };
}

export function createGptUsageTracker() {
  /** @type {Array<{ step: string, model: string, usage: object, recordedAt: string }>} */
  const records = [];

  return {
    record({ step, model, usage }) {
      const parsed = parseOpenAIUsage(usage);
      if (!parsed) {
        return;
      }
      records.push({
        step,
        model: model ?? "unknown",
        usage: parsed,
        recordedAt: new Date().toISOString(),
      });
    },
    getRecords() {
      return [...records];
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
  const incoming = {
    batchId: batchId ?? null,
    records: tracker.getRecords(),
    ...tracker.summary(),
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
