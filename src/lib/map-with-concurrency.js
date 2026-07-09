/**
 * Map async work over items with a bounded concurrency pool.
 * Results preserve input order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit — max concurrent workers (min 1)
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, fn) {
  const resolvedLimit = Math.max(1, limit ?? 1);
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
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.min(resolvedLimit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
