import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listTracks,
  pickByMood,
  calculateMusicGain,
  resolveTrackById,
  summarizeMusicLibraryForIndex,
  resetMusicCatalogCache,
  VOICE_TARGET_LUFS,
  MUSIC_DEFAULT_VOLUME_DB,
  MUSIC_DEFAULT_DUCKING_DB,
} from "../../src/editorial/music-library.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UPBEAT_BED = path.join(REPO_ROOT, "assets", "music", "upbeat_vlog_01.mp3");

function createTempCatalog(track, { createFile = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "music-lib-"));
  const filePath = path.join(tmpDir, track.fileName);
  if (createFile) {
    fs.writeFileSync(filePath, "");
  }
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

describe("music-library", () => {
  it("loads the repo catalog", () => {
    resetMusicCatalogCache();
    const tracks = listTracks();
    assert.ok(Array.isArray(tracks));
    assert.ok(tracks.every((track) => typeof track.trackId === "string"));
  });

  it("pickByMood prefers mood match when audio file exists", () => {
    const { catalogPath, cleanup } = createTempCatalog({
      trackId: "upbeat_vlog_01",
      fileName: "upbeat_vlog_01.mp3",
      mood: ["upbeat", "vlog", "energetic"],
      bpm: 120,
    });
    try {
      const track = pickByMood("upbeat", { bpm: 120, catalogPath });
      assert.equal(track.trackId, "upbeat_vlog_01");
    } finally {
      cleanup();
    }
  });

  it("pickByMood returns null when no track files exist on disk", () => {
    const { catalogPath, cleanup } = createTempCatalog({
      trackId: "upbeat_vlog_01",
      fileName: "missing_bed.mp3",
      mood: ["upbeat", "vlog", "energetic"],
      bpm: 120,
    }, { createFile: false });
    try {
      resetMusicCatalogCache();
      const track = pickByMood("upbeat", { bpm: 120, catalogPath });
      assert.equal(track, null);
    } finally {
      cleanup();
    }
  });

  it("resolveTrackById returns null with reason when file is missing", () => {
    const { catalogPath, cleanup } = createTempCatalog({
      trackId: "missing_track",
      fileName: "missing_track.mp3",
      mood: ["upbeat"],
      bpm: 120,
    }, { createFile: false });
    try {
      resetMusicCatalogCache();
      const result = resolveTrackById("missing_track", { catalogPath });
      assert.equal(result.track, null);
      assert.equal(result.reason, "track_file_missing");
    } finally {
      cleanup();
    }
  });

  it("resolveTrackById returns upbeat_vlog_01 when repo bed file exists", () => {
    if (!fs.existsSync(UPBEAT_BED)) {
      return;
    }
    resetMusicCatalogCache();
    const result = resolveTrackById("upbeat_vlog_01");
    assert.equal(result.track?.trackId, "upbeat_vlog_01");
    assert.equal(result.reason, null);
  });

  it("resolveTrackById returns track when file exists", () => {
    const { catalogPath, cleanup } = createTempCatalog({
      trackId: "test_track",
      fileName: "test_track.mp3",
      mood: ["upbeat"],
      bpm: 120,
    });
    try {
      const result = resolveTrackById("test_track", { catalogPath });
      assert.equal(result.track.trackId, "test_track");
      assert.equal(result.reason, null);
    } finally {
      cleanup();
    }
  });

  it("summarizeMusicLibraryForIndex excludes tracks with missing files", () => {
    resetMusicCatalogCache();
    const available = listTracks().filter((track) => resolveTrackById(track.trackId).track);
    const summary = summarizeMusicLibraryForIndex();
    assert.equal(summary.trackCount, available.length);
    assert.deepEqual(
      summary.tracks.map((track) => track.trackId),
      available.map((track) => track.trackId),
    );
  });

  it("calculateMusicGain adjusts relative to voice and track LUFS", () => {
    const gain = calculateMusicGain({
      voiceLufs: -20,
      trackLufs: -14,
      voiceTargetLufs: VOICE_TARGET_LUFS,
      baseVolumeDb: MUSIC_DEFAULT_VOLUME_DB,
    });
    assert.ok(Number.isFinite(gain));
    assert.notEqual(gain, MUSIC_DEFAULT_VOLUME_DB);
    assert.equal(MUSIC_DEFAULT_DUCKING_DB, -12);
  });
});
