import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveAudioMixPlanDefaults, mergeAudioMixPlan } from "../../src/editorial/audio-mix-plan.js";
import { resetMusicCatalogCache } from "../../src/editorial/music-library.js";
import { loadFixtureArtifact } from "../../src/test-helpers/fixture-work-dir.js";

function createTempCatalog(track) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mix-plan-"));
  const filePath = path.join(tmpDir, track.fileName);
  fs.writeFileSync(filePath, "");
  const catalogPath = path.join(tmpDir, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({
    version: "1.0",
    tracks: [track],
  }));
  return {
    catalogPath,
    cleanup: () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resetMusicCatalogCache();
    },
  };
}

describe("audio-mix-plan", () => {
  it("deriveAudioMixPlanDefaults recommends music for multi-clip batch", () => {
    const { catalogPath, cleanup } = createTempCatalog({
      trackId: "upbeat_vlog_01",
      fileName: "upbeat_vlog_01.mp3",
      mood: ["upbeat", "vlog", "energetic"],
      bpm: 120,
      integratedLufs: -14,
    });
    try {
      const audioIndex = loadFixtureArtifact("mini-day", "05d-audio-index.json");
      const plan = deriveAudioMixPlanDefaults({
        audioIndex,
        outputs: [{ outputId: "main_16x9", timeline: [{ videoOutSec: 120, videoInSec: 0 }] }],
        batchContext: { requiredFormats: ["16:9", "9:16"] },
        catalogPath,
      });

      assert.equal(plan.voiceTargetLufs, -16);
      assert.equal(plan.preWhisperNormalizeLufs, -18);
      assert.ok(plan.musicBed);
      assert.equal(plan.musicBed.trackId, "upbeat_vlog_01");
      assert.ok(plan.segments.length >= 1);
    } finally {
      cleanup();
    }
  });

  it("mergeAudioMixPlan fills missing fields from defaults", () => {
    const { catalogPath, cleanup } = createTempCatalog({
      trackId: "upbeat_vlog_01",
      fileName: "upbeat_vlog_01.mp3",
      mood: ["upbeat", "vlog", "energetic"],
      bpm: 120,
      integratedLufs: -14,
    });
    try {
      const defaults = deriveAudioMixPlanDefaults({
        audioIndex: loadFixtureArtifact("mini-day", "05d-audio-index.json"),
        outputs: [],
        batchContext: { requiredFormats: ["16:9"] },
        catalogPath,
      });

      const merged = mergeAudioMixPlan({ audioMixPlan: { voiceTargetLufs: -14 } }, defaults);
      assert.equal(merged.voiceTargetLufs, -14);
      assert.equal(merged.preWhisperNormalizeLufs, -18);
      assert.ok(merged.musicBed);
    } finally {
      cleanup();
    }
  });

  it("returns LUFS-only plan when music not recommended", () => {
    const plan = deriveAudioMixPlanDefaults({
      audioIndex: {
        clips: [{ clipId: "clip01", voiceLufs: -16, beatCount: 1, silenceGapCount: 0, totalSilenceSec: 0 }],
        batchSummary: { avgVoiceLufs: -16, totalSilenceSec: 0, clipCount: 1 },
      },
      outputs: [],
      batchContext: { requiredFormats: ["16:9"], notes: "no music" },
    });
    assert.equal(plan.musicBed, null);
  });
});
