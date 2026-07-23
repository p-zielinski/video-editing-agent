/**
 * Estimates director GPT user-payload size for provenance / quality diagnostics.
 * Token estimate uses chars/4 heuristic (aligned with rough GPT billing approximations).
 */

import { SEGMENT_BRIEF_ESTIMATED_TOKEN_BUDGET } from "../editorial/brief-caps.js";

export { SEGMENT_BRIEF_ESTIMATED_TOKEN_BUDGET };

/** Warn when a single call or total director brief budget is very large. */
export const BRIEF_METRICS_WARN_SINGLE_TOKENS = 80_000;
export const BRIEF_METRICS_WARN_TOTAL_TOKENS = 200_000;
/** Soft guard aligned with segment director budget (audit #6). */
export const BRIEF_METRICS_WARN_SEGMENT_TOKENS = SEGMENT_BRIEF_ESTIMATED_TOKEN_BUDGET;
/** Soft guard for drill-down payloads (~60k est.). */
export const BRIEF_METRICS_WARN_DRILL_DOWN_TOKENS = 60_000;

export function measureBriefPayload({
  task,
  userJson,
  brief = null,
  segmentId = null,
  meta = {},
}) {
  if (!task || typeof userJson !== "string") {
    throw new Error("measureBriefPayload requires task and userJson string");
  }

  const jsonBytes = Buffer.byteLength(userJson, "utf8");
  const estimatedTokens = Math.ceil(jsonBytes / 4);

  const topicIndex = brief?.topicIndex;
  const topicCount = Array.isArray(topicIndex)
    ? topicIndex.length
    : (topicIndex?.topics?.length ?? meta.topicCount ?? null);

  return {
    task,
    segmentId: segmentId ?? null,
    jsonBytes,
    estimatedTokens,
    sceneMapCount: brief?.sceneMap?.length ?? meta.sceneMapCount ?? null,
    sceneMapOmittedCount: brief?.sceneMapOmittedCount ?? meta.sceneMapOmittedCount ?? null,
    sceneMapPolicy: brief?.sceneMapPolicy ?? null,
    topicCount,
    transcriptExcerptCount: brief?.transcriptExcerpts?.length ?? meta.transcriptExcerptCount ?? null,
    segmentCatalogCount: meta.segmentCatalogCount ?? null,
    drillDownSceneCount: meta.drillDownSceneCount ?? null,
  };
}

export function createBriefMetricsAccumulator() {
  /** @type {Array<ReturnType<typeof measureBriefPayload>>} */
  const calls = [];

  return {
    record(metric) {
      if (metric) {
        calls.push(metric);
      }
    },
    finalize() {
      return {
        calls: [...calls],
        totals: {
          callCount: calls.length,
          jsonBytes: calls.reduce((sum, entry) => sum + entry.jsonBytes, 0),
          estimatedTokens: calls.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
        },
      };
    },
  };
}

function isSegmentDirectorTask(task) {
  return typeof task === "string" && task.startsWith("segment_director");
}

function isDrillDownTask(task) {
  return typeof task === "string" && task.includes("drill_down");
}

/** Warn when a single call or total director brief budget is very large. Soft only. */
export function evaluateBriefMetricsWarnings(briefMetrics) {
  const warnings = [];
  if (!briefMetrics?.calls?.length) {
    return warnings;
  }

  for (const call of briefMetrics.calls) {
    if (isSegmentDirectorTask(call.task)
      && call.estimatedTokens >= BRIEF_METRICS_WARN_SEGMENT_TOKENS) {
      warnings.push({
        code: "BRIEF_SEGMENT_BUDGET_EXCEEDED",
        task: call.task,
        segmentId: call.segmentId,
        estimatedTokens: call.estimatedTokens,
        jsonBytes: call.jsonBytes,
        budgetTokens: BRIEF_METRICS_WARN_SEGMENT_TOKENS,
      });
    }
    if (isDrillDownTask(call.task)
      && call.estimatedTokens >= BRIEF_METRICS_WARN_DRILL_DOWN_TOKENS) {
      warnings.push({
        code: "BRIEF_DRILL_DOWN_LARGE",
        task: call.task,
        segmentId: call.segmentId,
        estimatedTokens: call.estimatedTokens,
        jsonBytes: call.jsonBytes,
        budgetTokens: BRIEF_METRICS_WARN_DRILL_DOWN_TOKENS,
        drillDownSceneCount: call.drillDownSceneCount ?? null,
      });
    }
    if (call.estimatedTokens >= BRIEF_METRICS_WARN_SINGLE_TOKENS) {
      warnings.push({
        code: "BRIEF_PAYLOAD_LARGE",
        task: call.task,
        segmentId: call.segmentId,
        estimatedTokens: call.estimatedTokens,
        jsonBytes: call.jsonBytes,
      });
    }
  }

  const total = briefMetrics.totals?.estimatedTokens ?? 0;
  if (total >= BRIEF_METRICS_WARN_TOTAL_TOKENS) {
    warnings.push({
      code: "BRIEF_PAYLOAD_TOTAL_LARGE",
      estimatedTokens: total,
      jsonBytes: briefMetrics.totals?.jsonBytes ?? 0,
      callCount: briefMetrics.totals?.callCount ?? briefMetrics.calls.length,
    });
  }

  return warnings;
}

/**
 * Log soft warnings for a single brief metric (no throw).
 * @returns {ReturnType<typeof evaluateBriefMetricsWarnings>}
 */
export function warnBriefPayloadIfLarge(metric, { logger = console } = {}) {
  if (!metric) {
    return [];
  }
  const warnings = evaluateBriefMetricsWarnings({
    calls: [metric],
    totals: {
      callCount: 1,
      jsonBytes: metric.jsonBytes,
      estimatedTokens: metric.estimatedTokens,
    },
  });
  for (const warning of warnings) {
    const where = warning.segmentId ? ` segment=${warning.segmentId}` : "";
    const budget = warning.budgetTokens != null ? ` budget=${warning.budgetTokens}` : "";
    logger.warn?.(
      `[brief-metrics] ${warning.code}: task=${warning.task ?? "?"}${where}`
      + ` estTokens=${warning.estimatedTokens}${budget} (soft warn — no hard fail)`,
    );
  }
  return warnings;
}
