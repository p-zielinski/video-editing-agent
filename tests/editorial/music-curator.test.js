import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMusicCuratorContext,
  buildMusicCuratorShortlist,
  pickTrackDeterministic,
} from "../../src/editorial/music-catalog-filter.js";
import { runMusicCurator } from "../../src/agents/music-curator.js";
import { deriveAudioMixPlanDefaults } from "../../src/editorial/audio-mix-plan.js";
import { resetMusicCatalogCache } from "../../src/editorial/music-library.js";

function createTempCatalog(tracks) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "music-curator-"));
  for (const track of tracks) {
    fs.writeFileSync(path.join(tmpDir, track.fileName), "");
  }
  const catalogPath = path.join(tmpDir, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ version: "1.0", tracks }));
  return {
    catalogPath,
    cleanup: () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resetMusicCatalogCache();
    },
  };
}

describe("music-catalog-filter", () => {
  it("prefers energetic short candidates for 9:16 batch", () => {
    const { catalogPath, cleanup } = createTempCatalog([
      {
        trackId: "calm_01",
        fileName: "calm_01.mp3",
        title: "Calm",
        mood: ["calm", "reflective"],
        bpm: 85,
        durationSec: 180,
      },
      {
        trackId: "reel_01",
        fileName: "reel_01.mp3",
        title: "Club Reel",
        mood: ["energetic", "dance"],
        useCase: ["shorts"],
        energy: "high",
        bpm: 128,
        durationSec: 60,
        pixabay: {
          genre: ["Dance", "Electronic"],
          mood: ["Energetic", "Bright"],
          movement: ["Medium Fast"],
          theme: ["Music For Videos"],
        },
      },
    ]);

    try {
      const context = buildMusicCuratorContext({
        abstraction: { L3: { sessionSummary: "Dynamiczny reel gamingowy" } },
        requiredFormats: ["9:16"],
        batchContext: { shortsMaxDurationSec: 45 },
      });
      const shortlist = buildMusicCuratorShortlist(context, { catalogPath, limit: 5 });
      assert.equal(shortlist[0].trackId, "reel_01");
      const picked = pickTrackDeterministic(context, shortlist, { catalogPath });
      assert.equal(picked.trackId, "reel_01");
    } finally {
      cleanup();
    }
  });
});

describe("runMusicCurator", () => {
  it("uses user override without LLM", async () => {
    const { catalogPath, cleanup } = createTempCatalog([
      {
        trackId: "user_pick",
        fileName: "user_pick.mp3",
        title: "User Pick",
        mood: ["upbeat"],
        bpm: 120,
      },
    ]);

    try {
      const result = await runMusicCurator(null, {
        batchContext: { musicBedTrackId: "user_pick" },
        requiredFormats: ["9:16"],
        catalogPath,
      });
      assert.equal(result.musicSelection.trackId, "user_pick");
      assert.equal(result.musicSelection.source, "user_override");
    } finally {
      cleanup();
    }
  });

  it("falls back deterministically when client missing", async () => {
    const { catalogPath, cleanup } = createTempCatalog([
      {
        trackId: "a",
        fileName: "a.mp3",
        title: "A",
        mood: ["calm"],
        bpm: 90,
      },
      {
        trackId: "b",
        fileName: "b.mp3",
        title: "B",
        mood: ["energetic", "shorts"],
        useCase: ["shorts"],
        energy: "high",
        bpm: 128,
        durationSec: 60,
      },
    ]);

    try {
      const result = await runMusicCurator(null, {
        abstraction: { L3: { sessionSummary: "Szybki short z energią" } },
        requiredFormats: ["9:16"],
        batchContext: { shortsMaxDurationSec: 45 },
        catalogPath,
      });
      assert.equal(result.musicSelection.trackId, "b");
      assert.equal(result.usedFallback, true);
    } finally {
      cleanup();
    }
  });

  it("calls nano model when client provided", async () => {
    const { catalogPath, cleanup } = createTempCatalog([
      {
        trackId: "a",
        fileName: "a.mp3",
        title: "A",
        mood: ["calm"],
        bpm: 90,
      },
      {
        trackId: "b",
        fileName: "b.mp3",
        title: "B",
        mood: ["energetic"],
        useCase: ["shorts"],
        bpm: 128,
      },
    ]);

    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify({
              trackId: "b",
              reason: "Pasuje do energicznego shorta",
              confidence: 0.9,
            }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        },
      },
    };

    try {
      const result = await runMusicCurator(client, {
        abstraction: { L3: { sessionSummary: "Energetyczny short" } },
        requiredFormats: ["9:16"],
        catalogPath,
      });
      assert.equal(result.musicSelection.trackId, "b");
      assert.equal(result.musicSelection.source, "llm");
    } finally {
      cleanup();
    }
  });
});

describe("deriveAudioMixPlanDefaults with musicSelection", () => {
  it("uses curator trackId in defaults", () => {
    const { catalogPath, cleanup } = createTempCatalog([
      {
        trackId: "curator_pick",
        fileName: "curator_pick.mp3",
        title: "Curator Pick",
        mood: ["energetic"],
        bpm: 120,
        integratedLufs: -14,
      },
    ]);

    try {
      const plan = deriveAudioMixPlanDefaults({
        audioIndex: { batchSummary: { clipCount: 1 } },
        batchContext: { requiredFormats: ["9:16"] },
        musicSelection: {
          trackId: "curator_pick",
          reason: "test",
          source: "llm",
        },
        catalogPath,
      });
      assert.equal(plan.musicBed.trackId, "curator_pick");
    } finally {
      cleanup();
    }
  });
});
