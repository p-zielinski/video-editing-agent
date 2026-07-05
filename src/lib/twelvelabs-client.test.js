import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mergeAndDedupeMoments,
  parseAnalyzeData,
  summarizeTwelveLabsForBrief,
  refreshVideoInsightsFromAsset,
  indexVideoFromPath,
} from "./twelvelabs-client.js";

function mockTwelveLabsFetch() {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? "GET" });
    const pathname = new URL(url).pathname;
    if (pathname.includes("/gist")) {
      return {
        ok: true,
        text: async () => JSON.stringify({ title: "City walk", topics: ["travel"] }),
      };
    }
    if (pathname.endsWith("/search")) {
      return { ok: true, text: async () => JSON.stringify({ data: [] }) };
    }
    if (pathname.endsWith("/analyze")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: {
            summary: "A walk through the city",
            chapters: [{ chapter_title: "Start", start: 0, end: 30 }],
            highlights: [{ description: "Crowd", start: 5, end: 12 }],
          },
        }),
      };
    }
    if (pathname.includes("/videos/")) {
      return {
        ok: true,
        text: async () => JSON.stringify({ title: "City walk", chapters: [] }),
      };
    }
    if (pathname.endsWith("/tasks")) {
      return {
        ok: false,
        text: async () => JSON.stringify({ error: "upload should be skipped" }),
      };
    }
    return { ok: true, text: async () => JSON.stringify({}) };
  };
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("twelvelabs-client", () => {
  describe("parseAnalyzeData", () => {
    it("parses JSON string payloads", () => {
      const parsed = parseAnalyzeData('{"summary":"Walk","chapters":[],"highlights":[]}');
      assert.equal(parsed.summary, "Walk");
    });

    it("returns object payloads unchanged", () => {
      const input = { summary: "City" };
      assert.deepEqual(parseAnalyzeData(input), input);
    });
  });

  describe("mergeAndDedupeMoments", () => {
    it("dedupes overlapping moments and keeps richer description", () => {
      const merged = mergeAndDedupeMoments([
        [{ startSec: 5, endSec: 10, description: "Short" }],
        [{ startSec: 5.5, endSec: 11, description: "Longer description" }],
      ]);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].description, "Longer description");
    });

    it("sorts moments by startSec", () => {
      const merged = mergeAndDedupeMoments([
        [{ startSec: 20, description: "B" }],
        [{ startSec: 5, description: "A" }],
      ]);
      assert.deepEqual(merged.map((m) => m.description), ["A", "B"]);
    });
  });

  describe("summarizeTwelveLabsForBrief", () => {
    it("skips stub artifacts and returns enriched indexed clip", () => {
      const summary = summarizeTwelveLabsForBrief({
        clip01: { indexingStatus: "stub", moments: [] },
        clip02: {
          indexingStatus: "indexed",
          clipSummary: "City walk",
          chapters: [{ startSec: 0, endSec: 30, title: "Start" }],
          moments: [{ startSec: 5, endSec: 12, description: "Crowd", editUse: "hook" }],
          editorial: {
            mood: "energetic",
            narrativeRole: "broll_pool",
            editingHints: ["Use as establishing shot"],
          },
          gist: { topics: ["travel", "street"] },
        },
      });

      assert.equal(summary?.length, 1);
      assert.equal(summary[0].clipId, "clip02");
      assert.equal(summary[0].mood, "energetic");
      assert.equal(summary[0].narrativeRole, "broll_pool");
      assert.equal(summary[0].editingHints[0], "Use as establishing shot");
      assert.deepEqual(summary[0].topics, ["travel", "street"]);
      assert.equal(summary[0].moments[0].editUse, "hook");
    });
  });

  describe("refreshVideoInsightsFromAsset", () => {
    it("fetches insights without creating an indexing task", async () => {
      const mock = mockTwelveLabsFetch();
      try {
        const result = await refreshVideoInsightsFromAsset({
          apiKey: "test-key",
          indexId: "idx-1",
          videoId: "vid-existing",
        });

        assert.equal(result.twelveLabsAssetId, "vid-existing");
        assert.equal(result.indexingStatus, "indexed");
        assert.equal(result.clipSummary, "City walk");
        assert.ok(result.moments.some((moment) => moment.description === "Crowd"));
        assert.ok(
          !mock.requests.some((request) => request.url.includes("/tasks") && request.method === "POST"),
        );
      } finally {
        mock.restore();
      }
    });
  });

  describe("indexVideoFromPath skipUpload", () => {
    it("reuses existing video id and skips upload when skipUpload is true", async () => {
      const mock = mockTwelveLabsFetch();
      try {
        const result = await indexVideoFromPath({
          apiKey: "test-key",
          indexId: "idx-1",
          sourcePath: "/missing/clip01.mp4",
          clipId: "clip01",
          existingVideoId: "vid-existing",
          skipUpload: true,
        });

        assert.equal(result.twelveLabsAssetId, "vid-existing");
        assert.equal(result.indexingStatus, "indexed");
        assert.equal(result.taskId, undefined);
        assert.ok(
          !mock.requests.some((request) => request.url.includes("/tasks") && request.method === "POST"),
        );
      } finally {
        mock.restore();
      }
    });
  });
});
