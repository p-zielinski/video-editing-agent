import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import {
  enrichMusicAfterIngest,
  enrichSfxAfterIngest,
} from "./catalog-post-ingest-enrich.js";
import { loadCatalog } from "./ingest-music-track.js";
import { loadSfxCatalog } from "./ingest-sfx-track.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function writeMusicCatalog(catalogPath, tracks) {
  fs.writeFileSync(
    catalogPath,
    `${JSON.stringify({ version: "1.0", tracks }, null, 2)}\n`,
    "utf8",
  );
}

function writeSfxCatalog(catalogPath, sounds) {
  fs.writeFileSync(
    catalogPath,
    `${JSON.stringify({ version: "1.0", sounds }, null, 2)}\n`,
    "utf8",
  );
}

describe("catalog-post-ingest-enrich", () => {
  /** @type {string | undefined} */
  let savedApiKey;

  beforeEach(() => {
    savedApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
  });

  afterEach(() => {
    if (savedApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = savedApiKey;
    }
  });

  it("enrichMusicAfterIngest throws when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    await assert.rejects(
      () => enrichMusicAfterIngest({
        trackId: "pixabay_1",
        catalogPath: "/tmp/catalog.json",
      }),
      /OPENAI_API_KEY/,
    );
  });

  it("enrichSfxAfterIngest throws when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    await assert.rejects(
      () => enrichSfxAfterIngest({
        sfxId: "pixabay_sfx_1",
        catalogPath: "/tmp/catalog.json",
        sfxDir: "/tmp",
      }),
      /OPENAI_API_KEY/,
    );
  });

  it("enrichMusicAfterIngest saves AI description to catalog", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(TEST_DIR, "post-ingest-music-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const catalogPath = path.join(tmpDir, "catalog.json");
    writeMusicCatalog(catalogPath, [{
      trackId: "pixabay_99",
      fileName: "test.mp3",
      title: "Test Track",
      mood: ["bright"],
      useCase: ["youtube"],
    }]);

    const result = await enrichMusicAfterIngest({
      trackId: "pixabay_99",
      catalogPath,
      client: {},
      describeFn: async () => ({
        description: "Energetyczny future bass pod shorty.",
        mood: ["uplifting"],
        useCase: ["shorts"],
        goodFor: ["short"],
        energy: "high",
        hasVocals: false,
        directorUseCases: ["dynamiczny hook"],
        suggestedBedVolumeDb: -20,
      }),
    });

    assert.equal(result.enriched, true);
    assert.equal(result.skipped, false);
    assert.match(result.description, /future bass/i);

    const saved = loadCatalog(catalogPath);
    const track = saved.tracks.find((entry) => entry.trackId === "pixabay_99");
    assert.equal(track.description, "Energetyczny future bass pod shorty.");
    assert.ok(track.aiEnrichedAt);
  });

  it("enrichMusicAfterIngest skips already enriched track without force", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(TEST_DIR, "post-ingest-music-skip-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const catalogPath = path.join(tmpDir, "catalog.json");
    writeMusicCatalog(catalogPath, [{
      trackId: "pixabay_100",
      title: "Done",
      description: "Istniejący opis.",
      directorUseCases: ["vlog"],
      aiEnrichedAt: "2026-01-01T00:00:00.000Z",
    }]);

    let called = false;
    const result = await enrichMusicAfterIngest({
      trackId: "pixabay_100",
      catalogPath,
      client: {},
      describeFn: async () => {
        called = true;
        return null;
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "already_enriched");
    assert.equal(called, false);
  });

  it("enrichMusicAfterIngest re-enriches with force", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(TEST_DIR, "post-ingest-music-force-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const catalogPath = path.join(tmpDir, "catalog.json");
    writeMusicCatalog(catalogPath, [{
      trackId: "pixabay_101",
      title: "Old",
      description: "Stary opis.",
      directorUseCases: ["vlog"],
      aiEnrichedAt: "2026-01-01T00:00:00.000Z",
    }]);

    const result = await enrichMusicAfterIngest({
      trackId: "pixabay_101",
      catalogPath,
      force: true,
      client: {},
      describeFn: async () => ({
        description: "Nowy opis AI.",
        mood: ["calm"],
        useCase: ["vlog"],
        goodFor: ["main"],
        energy: "low",
        hasVocals: false,
        directorUseCases: ["tło pod narrację"],
        suggestedBedVolumeDb: -18,
      }),
    });

    assert.equal(result.enriched, true);
    const saved = loadCatalog(catalogPath);
    assert.equal(saved.tracks[0].description, "Nowy opis AI.");
  });

  it("enrichSfxAfterIngest saves AI description to catalog (text-only)", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(TEST_DIR, "post-ingest-sfx-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const catalogPath = path.join(tmpDir, "catalog.json");
    const sfxDir = path.join(tmpDir, "sfx");
    fs.mkdirSync(sfxDir);
    fs.writeFileSync(path.join(sfxDir, "whoosh.wav"), "audio");

    writeSfxCatalog(catalogPath, [{
      sfxId: "pixabay_sfx_42",
      fileName: "whoosh.wav",
      title: "Fast Whoosh",
      tags: ["whoosh"],
      category: "transition",
      durationSec: 1.2,
    }]);

    const result = await enrichSfxAfterIngest({
      sfxId: "pixabay_sfx_42",
      catalogPath,
      sfxDir,
      textOnly: true,
      client: {},
      describeFn: async () => ({
        description: "Krótki whoosh przejścia.",
        tags: ["whoosh", "transition"],
        category: "transition",
        useCases: ["cięcie między ujęciami"],
        loudnessCharacter: "medium",
        isLoop: false,
      }),
    });

    assert.equal(result.enriched, true);
    assert.match(result.description, /whoosh/i);

    const saved = loadSfxCatalog(catalogPath);
    const sound = saved.sounds.find((entry) => entry.sfxId === "pixabay_sfx_42");
    assert.equal(sound.description, "Krótki whoosh przejścia.");
    assert.ok(sound.aiEnrichedAt);
  });

  it("enrichSfxAfterIngest skips already enriched sound without force", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(TEST_DIR, "post-ingest-sfx-skip-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const catalogPath = path.join(tmpDir, "catalog.json");
    writeSfxCatalog(catalogPath, [{
      sfxId: "pixabay_sfx_43",
      title: "Done",
      description: "Gotowy opis.",
      tags: ["whoosh", "transition"],
      aiEnrichedAt: "2026-01-01T00:00:00.000Z",
    }]);

    const result = await enrichSfxAfterIngest({
      sfxId: "pixabay_sfx_43",
      catalogPath,
      sfxDir: tmpDir,
      client: {},
      describeFn: async () => null,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "already_enriched");
  });
});
