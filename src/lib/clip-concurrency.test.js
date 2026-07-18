import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getAudioConcurrencyLimit,
  getClipConcurrencyLimit,
  getGpuConcurrencyLimit,
  runWithConcurrency,
} from "./clip-concurrency.js";

describe("clip-concurrency", () => {
  let previousClipEnv;
  let previousGpuEnv;

  beforeEach(() => {
    previousClipEnv = process.env.CLIP_CONCURRENCY;
    previousGpuEnv = process.env.GPU_CONCURRENCY;
    delete process.env.CLIP_CONCURRENCY;
    delete process.env.GPU_CONCURRENCY;
  });

  afterEach(() => {
    if (previousClipEnv === undefined) {
      delete process.env.CLIP_CONCURRENCY;
    } else {
      process.env.CLIP_CONCURRENCY = previousClipEnv;
    }
    if (previousGpuEnv === undefined) {
      delete process.env.GPU_CONCURRENCY;
    } else {
      process.env.GPU_CONCURRENCY = previousGpuEnv;
    }
  });

  it("getClipConcurrencyLimit defaults to 2", () => {
    assert.equal(getClipConcurrencyLimit(), 2);
  });

  it("getGpuConcurrencyLimit defaults to 1", () => {
    assert.equal(getGpuConcurrencyLimit(), 1);
  });

  it("getAudioConcurrencyLimit defaults to 1", () => {
    assert.equal(getAudioConcurrencyLimit(), 1);
  });

  it("reads limits from env", () => {
    process.env.CLIP_CONCURRENCY = "4";
    process.env.GPU_CONCURRENCY = "3";
    assert.equal(getClipConcurrencyLimit(), 4);
    assert.equal(getGpuConcurrencyLimit(), 3);
  });

  it("ignores invalid env values", () => {
    process.env.CLIP_CONCURRENCY = "0";
    process.env.GPU_CONCURRENCY = "bad";
    assert.equal(getClipConcurrencyLimit(), 2);
    assert.equal(getGpuConcurrencyLimit(), 1);
  });

  it("runWithConcurrency preserves order and respects limit", async () => {
    const items = [1, 2, 3, 4, 5];
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await runWithConcurrency(
      items,
      async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return item * 2;
      },
      { limit: 2 },
    );

    assert.deepEqual(results, [2, 4, 6, 8, 10]);
    assert.equal(maxInFlight, 2);
  });

  it("runWithConcurrency returns empty array for no items", async () => {
    const results = await runWithConcurrency([], async () => 1);
    assert.deepEqual(results, []);
  });

  it("runWithConcurrency propagates errors with label", async () => {
    await assert.rejects(
      () => runWithConcurrency(
        [1],
        async () => {
          throw new Error("boom");
        },
        { label: "transcribe" },
      ),
      /transcribe: boom/,
    );
  });

  it("runWithConcurrency collect mode returns errors without throwing", async () => {
    const output = await runWithConcurrency(
      [{ clipId: "clip01" }, { clipId: "clip02" }],
      async (item) => {
        if (item.clipId === "clip02") {
          throw new Error("fail clip02");
        }
        return item.clipId;
      },
      { onError: "collect", label: "transcribe" },
    );
    assert.equal(output.errors.length, 1);
    assert.equal(output.errors[0].item.clipId, "clip02");
    assert.equal(output.results[0], "clip01");
  });
});
