function parseLimit(envName, defaultValue) {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function getClipConcurrencyLimit() {
  return parseLimit("CLIP_CONCURRENCY", 2);
}

export function getGpuConcurrencyLimit() {
  return parseLimit("GPU_CONCURRENCY", 1);
}

/** Audio analysis spawns librosa + PANNs per clip — default 1 to avoid RAM spikes. */
export function getAudioConcurrencyLimit() {
  return parseLimit("AUDIO_CONCURRENCY", 1);
}

/**
 * Run async work over items with a bounded worker pool.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {{ limit?: number, label?: string, onError?: "fail_fast" | "collect" }} [options]
 * @returns {Promise<R[] | { results: R[], errors: Array<{ index: number, item: T, error: Error }> }>}
 */
export async function runWithConcurrency(items, fn, { limit, label, onError = "fail_fast" } = {}) {
  const resolvedLimit = Math.max(1, limit ?? getClipConcurrencyLimit());
  if (items.length === 0) {
    return onError === "collect" ? { results: [], errors: [] } : [];
  }

  const results = new Array(items.length);
  const errors = [];
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        break;
      }
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (onError === "collect") {
          errors.push({ index, item: items[index], error: normalized });
          continue;
        }
        if (label) {
          const detail = normalized.message;
          throw new Error(`${label}: ${detail}`, { cause: normalized });
        }
        throw normalized;
      }
    }
  }

  const workerCount = Math.min(resolvedLimit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (onError === "collect") {
    return { results, errors };
  }
  return results;
}
