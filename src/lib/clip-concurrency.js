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

/**
 * Run async work over items with a bounded worker pool.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {{ limit?: number, label?: string }} [options]
 * @returns {Promise<R[]>}
 */
export async function runWithConcurrency(items, fn, { limit, label } = {}) {
  const resolvedLimit = Math.max(1, limit ?? getClipConcurrencyLimit());
  if (items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
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
        if (label) {
          error.message = `${label}: ${error.message}`;
        }
        throw error;
      }
    }
  }

  const workerCount = Math.min(resolvedLimit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
