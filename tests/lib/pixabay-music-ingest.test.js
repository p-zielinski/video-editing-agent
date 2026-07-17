import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCatalogEntry,
  upsertCatalogTrack,
  loadCatalog,
} from "../../src/lib/ingest-music-track.js";
import {
  buildTrackId,
  deriveEnergyLevel,
  deriveMoodTags,
  deriveUseCaseTags,
  expectedMp3FileNameFromUrl,
  extractPixabayIdFromUrl,
  listMp3CandidatesForPixabayUrl,
  parsePixabayMusicPage,
  resolveMusicFileForPixabayUrl,
} from "../../src/lib/pixabay-music-page.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="Club Party Dance Music | Royalty-free Music - Pixabay" />
</head>
<body>
  <h1>Club Party Dance Music</h1>
  <dl>
    <dt>Genre</dt><dd><a href="#">Dance</a><a href="#">Upbeat</a><a href="#">Electronic</a><a href="#">Pop</a></dd>
    <dt>Mood</dt><dd><a href="#">Uplifting</a><a href="#">Restless</a><a href="#">Bright</a><a href="#">Energetic</a></dd>
    <dt>Movement</dt><dd><a href="#">Chasing</a><a href="#">Running</a><a href="#">Medium Fast</a></dd>
    <dt>Theme</dt><dd><a href="#">Music For Videos</a><a href="#">Music For Youtube Videos</a><a href="#">Vlog Music</a></dd>
  </dl>
</body>
</html>`;

describe("pixabay-music-page", () => {
  it("extracts pixabay id from url", () => {
    assert.equal(
      extractPixabayIdFromUrl("https://pixabay.com/music/upbeat-club-party-dance-music-560133/"),
      "560133",
    );
  });

  it("builds expected mp3 name from url slug", () => {
    assert.equal(
      expectedMp3FileNameFromUrl("https://pixabay.com/music/future-bass-no-copyright-music-537751/"),
      "future-bass-no-copyright-music-537751.mp3",
    );
  });

  it("lists id-suffixed mp3 candidates when slug file is absent", () => {
    const candidates = listMp3CandidatesForPixabayUrl(
      "https://pixabay.com/music/future-bass-no-copyright-music-537751/",
      ["sigmamusicart-no-copyright-music-537751.mp3", "other.mp3"],
    );
    assert.deepEqual(candidates, [
      "future-bass-no-copyright-music-537751.mp3",
      "sigmamusicart-no-copyright-music-537751.mp3",
    ]);
  });

  it("resolves mp3 by pixabay id suffix in music dir", (t) => {
    const tmpDir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "music-resolve-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const fileName = "sigmamusicart-no-copyright-music-537751.mp3";
    fs.writeFileSync(path.join(tmpDir, fileName), "audio");

    const resolved = resolveMusicFileForPixabayUrl(
      "https://pixabay.com/music/future-bass-no-copyright-music-537751/",
      tmpDir,
    );

    assert.equal(resolved?.fileName, fileName);
    assert.equal(resolved?.match, "pixabay_id");
  });

  it("parses genre/mood/movement/theme 1:1 from html", () => {
    const parsed = parsePixabayMusicPage(FIXTURE_HTML, {
      url: "https://pixabay.com/music/upbeat-club-party-dance-music-560133/",
    });

    assert.equal(parsed.title, "Club Party Dance Music");
    assert.equal(parsed.pixabayId, "560133");
    assert.deepEqual(parsed.pixabay.genre, ["Dance", "Upbeat", "Electronic", "Pop"]);
    assert.deepEqual(parsed.pixabay.mood, ["Uplifting", "Restless", "Bright", "Energetic"]);
    assert.deepEqual(parsed.pixabay.movement, ["Chasing", "Running", "Medium Fast"]);
    assert.deepEqual(parsed.pixabay.theme, [
      "Music For Videos",
      "Music For Youtube Videos",
      "Vlog Music",
    ]);
  });

  it("parses polish section labels from html", () => {
    const polishHtml = `<!DOCTYPE html><html><body><dl>
      <dt>Gatunek</dt><dd><a href="#">Rock</a><a href="#">Indie</a></dd>
      <dt>Nastrój</dt><dd><a href="#">Energetic</a><a href="#">Bright</a></dd>
      <dt>Ruch</dt><dd><a href="#">Running</a></dd>
      <dt>Motyw</dt><dd><a href="#">Vlog Music</a></dd>
    </dl></body></html>`;
    const parsed = parsePixabayMusicPage(polishHtml, {
      url: "https://pixabay.com/pl/music/g%C5%82az-indie-rock-518575/",
      title: "Głaz",
    });

    assert.deepEqual(parsed.pixabay.genre, ["Rock", "Indie"]);
    assert.deepEqual(parsed.pixabay.mood, ["Energetic", "Bright"]);
    assert.deepEqual(parsed.pixabay.movement, ["Running"]);
    assert.deepEqual(parsed.pixabay.theme, ["Vlog Music"]);
  });

  it("derives curator-facing tags", () => {
    const parsed = parsePixabayMusicPage(FIXTURE_HTML, {
      url: "https://pixabay.com/music/upbeat-club-party-dance-music-560133/",
    });

    assert.ok(deriveMoodTags(parsed.pixabay).includes("energetic"));
    assert.ok(deriveUseCaseTags(parsed.pixabay).includes("youtube"));
    assert.equal(deriveEnergyLevel(parsed.pixabay), "high");
    assert.equal(
      buildTrackId({ pixabayId: parsed.pixabayId, fileName: "club_party_560133.mp3" }),
      "pixabay_560133",
    );
  });
});

describe("ingest-music-track catalog", () => {
  it("upserts catalog entry", (t) => {
    const tmpDir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "music-ingest-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const catalogPath = path.join(tmpDir, "catalog.json");

    const entry = buildCatalogEntry({
      fileName: "club_party_560133.mp3",
      parsedPage: parsePixabayMusicPage(FIXTURE_HTML, {
        url: "https://pixabay.com/music/upbeat-club-party-dance-music-560133/",
      }),
      analysis: {
        durationSec: 41,
        bpm: 128,
        integratedLufs: -14.2,
        beatGrid: { beatsSec: [0.5, 1.0], barSec: [1.0], source: "librosa" },
      },
    });

    upsertCatalogTrack(catalogPath, entry);
    const catalog = loadCatalog(catalogPath);
    assert.equal(catalog.tracks.length, 1);
    assert.equal(catalog.tracks[0].trackId, "pixabay_560133");
    assert.equal(catalog.tracks[0].energy, "high");

    assert.throws(
      () => upsertCatalogTrack(catalogPath, entry),
      /już istnieje/,
    );

    upsertCatalogTrack(catalogPath, { ...entry, title: "Updated" }, { force: true });
    assert.equal(loadCatalog(catalogPath).tracks[0].title, "Updated");
  });
});
