export function detectInputMode(clipCount, batchContext = {}) {
  if (batchContext.inputMode) {
    // Never trust LLM/stale single_clip when the batch clearly has multiple clips.
    if (batchContext.inputMode === "single_clip" && clipCount > 1) {
      return "multi_clip_day";
    }
    return batchContext.inputMode;
  }
  if (clipCount <= 1) {
    return "single_clip";
  }
  return "multi_clip_day";
}

/**
 * Default ingest sort: multi-clip batches prefer recording time from metadata.
 */
export function resolveDefaultSortBy(clipCount, batchContext = {}) {
  if (batchContext.sortBy) {
    return batchContext.sortBy;
  }
  if (clipCount > 1 || batchContext.inputMode === "multi_clip_day") {
    return "creation_time";
  }
  return "mtime";
}

export function parseBatchContextFromUserContext(userContext) {
  if (!userContext || typeof userContext !== "string") {
    return {};
  }
  const trimmed = userContext.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return { notes: userContext };
    }
  }
  return { notes: userContext };
}
