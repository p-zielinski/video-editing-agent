import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "./map-with-concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns empty array for empty input", async () => {
    const result = await mapWithConcurrency([], 3, async () => 1);
    assert.deepEqual(result, []);
  });

  it("preserves result order", async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await mapWithConcurrency(items, 2, async (n) => n * 2);
    assert.deepEqual(result, [2, 4, 6, 8, 10]);
  });

  it("limits concurrent executions", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return n;
    });

    assert.equal(maxInFlight, 3);
  });

  it("passes index to mapper", async () => {
    const result = await mapWithConcurrency(["a", "b", "c"], 2, async (_item, index) => index);
    assert.deepEqual(result, [0, 1, 2]);
  });

  it("treats limit below 1 as 1", async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    const items = [1, 2, 3];

    await mapWithConcurrency(items, 0, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    assert.equal(maxInFlight, 1);
  });

  it("propagates errors from mapper", async () => {
    await assert.rejects(
      () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) {
          throw new Error("boom");
        }
        return n;
      }),
      /boom/,
    );
  });
});
