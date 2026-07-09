/**
 * Estimates director GPT user-payload size for provenance / quality diagnostics.
 * Token estimate uses chars/4 heuristic (aligned with rough GPT billing approximations).
 */

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

/** Warn when a single call or total director brief budget is very large. */
export const BRIEF_METRICS_WARN_SINGLE_TOKENS = 80_000;
export const BRIEF_METRICS_WARN_TOTAL_TOKENS = 200_000;

export function evaluateBriefMetricsWarnings(briefMetrics) {
  const warnings = [];
  if (!briefMetrics?.calls?.length) {
    return warnings;
  }

  for (const call of briefMetrics.calls) {
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
