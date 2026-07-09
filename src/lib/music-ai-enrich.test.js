import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyMusicAiEnrichment,
  buildMusicEnrichUserText,
  enrichMusicCatalogTrack,
  normalizeMusicAiEnrichment,
  suggestMusicBedVolumeDb,
} from "./music-ai-enrich.js";
import {
  enrichMusicSelectionFromCatalog,
  formatTrackForCuratorBrief,
} from "../editorial/music-catalog-filter.js";

describe("music-ai-enrich", () => {
  it("normalizeMusicAiEnrichment keeps description and goodFor", () => {
    const normalized = normalizeMusicAiEnrichment({
      description: "Energetyczny future bass z mocnym kickiem.",
      mood: ["uplifting", "electronic"],
      useCase: ["shorts", "vlog"],
      goodFor: ["short", "main"],
      energy: "high",
      hasVocals: false,
      directorUseCases: ["dynamiczny short hook"],
      suggestedBedVolumeDb: -20,
    });

    assert.ok(normalized);
    assert.match(normalized.description, /future bass/i);
    assert.deepEqual(normalized.goodFor, ["short", "main"]);
    assert.equal(normalized.energy, "high");
  });

  it("suggestMusicBedVolumeDb lowers volume for loud tracks", () => {
    const loud = suggestMusicBedVolumeDb({ integratedLufs: -8 });
    const quiet = suggestMusicBedVolumeDb({ integratedLufs: -18 });
    assert.ok(loud < quiet);
  });

  it("applyMusicAiEnrichment stores description and directorUseCases", () => {
    const enriched = applyMusicAiEnrichment(
      { trackId: "x", title: "Funk", integratedLufs: -10 },
      {
        description: "Funkowy groove z breakbeatem.",
        mood: ["funk", "energetic"],
        useCase: ["vlog"],
        goodFor: ["main"],
        energy: "medium",
        hasVocals: false,
        directorUseCases: ["tło pod narrację dzienną"],
        suggestedBedVolumeDb: -19,
      },
      { model: "gpt-5.4-nano" },
    );

    assert.equal(enriched.description, "Funkowy groove z breakbeatem.");
    assert.ok(enriched.aiEnrichedAt);
    assert.equal(enriched.suggestedBedVolumeDb, -19);
  });

  it("buildMusicEnrichUserText includes pixabay buckets", () => {
    const text = buildMusicEnrichUserText({
      trackId: "pixabay_1",
      title: "Test",
      fileName: "test.mp3",
      mood: ["bright"],
      useCase: ["youtube"],
      pixabay: { genre: ["Funk"], mood: ["Energetic"] },
    });
    assert.match(text, /genre: Funk/);
  });

  it("enrichMusicCatalogTrack uses mocked describeFn", async () => {
    const result = await enrichMusicCatalogTrack(
      { trackId: "x", title: "Ambient", mood: [], useCase: [] },
      {
        client: {},
        describeFn: async () => ({
          description: "Spokojny ambient bez wokalu.",
          mood: ["calm"],
          useCase: ["vlog"],
          goodFor: ["main"],
          energy: "low",
          hasVocals: false,
          directorUseCases: ["spokojny main vlog"],
        }),
      },
    );

    assert.equal(result.skipped, false);
    assert.equal(result.track.description, "Spokojny ambient bez wokalu.");
  });
});

describe("formatTrackForCuratorBrief", () => {
  it("exposes enriched fields for music curator", () => {
    const brief = formatTrackForCuratorBrief({
      trackId: "pixabay_1",
      title: "Funk",
      description: "Funkowy groove.",
      mood: ["funk"],
      useCase: ["vlog"],
      goodFor: ["main"],
      directorUseCases: ["narracja"],
      integratedLufs: -10,
      bpm: 120,
      durationSec: 124,
      energy: "high",
    });

    assert.equal(brief.description, "Funkowy groove.");
    assert.deepEqual(brief.directorUseCases, ["narracja"]);
    assert.ok(brief.suggestedBedVolumeDb < -18);
  });
});

describe("enrichMusicSelectionFromCatalog", () => {
  it("returns null-safe when selection missing", () => {
    assert.equal(enrichMusicSelectionFromCatalog(null), null);
  });
});
