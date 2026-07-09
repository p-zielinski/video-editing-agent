import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSfxCatalogEntry,
  upsertSfxCatalogSound,
  loadSfxCatalog,
} from "../../src/lib/ingest-sfx-track.js";
import {
  buildSfxId,
  deriveEditorialTags,
  deriveSfxCategory,
  expectedAudioFileNamesFromUrl,
  parsePixabaySfxPage,
  resolveSfxFileForPixabayUrl,
} from "../../src/lib/pixabay-sfx-page.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="Fast Whoosh Transition | Sound Effect - Pixabay" />
</head>
<body>
  <h1>Fast Whoosh Transition</h1>
  <dl>
    <dt>Tags</dt><dd><a href="#">Whoosh</a><a href="#">Transition</a><a href="#">Swoosh</a></dd>
    <dt>Category</dt><dd><a href="#">Sound effects</a></dd>
  </dl>
</body>
</html>`;

const SFX_URL = "https://pixabay.com/sound-effects/fast-whoosh-transition-123456/";

describe("pixabay-sfx-page", () => {
  it("builds expected audio filenames from url slug", () => {
    assert.deepEqual(
      expectedAudioFileNamesFromUrl(SFX_URL),
      [
        "fast-whoosh-transition-123456.wav",
        "fast-whoosh-transition-123456.mp3",
        "fast-whoosh-transition-123456.ogg",
        "fast-whoosh-transition-123456.m4a",
        "fast-whoosh-transition-123456.flac",
      ],
    );
  });

  it("resolves sfx file by pixabay id suffix", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "sfx-resolve-"));
    const fileName = "creator-fast-whoosh-123456.wav";
    fs.writeFileSync(path.join(tmpDir, fileName), "audio");

    const resolved = resolveSfxFileForPixabayUrl(SFX_URL, tmpDir);
    assert.equal(resolved?.fileName, fileName);
    assert.equal(resolved?.match, "pixabay_id");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses tags and category from html", () => {
    const parsed = parsePixabaySfxPage(FIXTURE_HTML, { url: SFX_URL });
    assert.equal(parsed.title, "Fast Whoosh Transition");
    assert.equal(parsed.pixabayId, "123456");
    assert.deepEqual(parsed.rawTags, ["Whoosh", "Transition", "Swoosh"]);
    assert.ok(parsed.tags.includes("whoosh"));
    assert.equal(parsed.category, "transition");
  });

  it("builds stable sfxId", () => {
    assert.equal(buildSfxId({ pixabayId: "123456", fileName: "x.wav" }), "pixabay_sfx_123456");
  });
});

describe("ingest-sfx-track catalog", () => {
  it("upserts sfx catalog entry", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "sfx-ingest-"));
    const catalogPath = path.join(tmpDir, "catalog.json");
    const parsed = parsePixabaySfxPage(FIXTURE_HTML, { url: SFX_URL });

    const entry = buildSfxCatalogEntry({
      fileName: "creator-fast-whoosh-123456.wav",
      parsedPage: parsed,
      analysis: { durationSec: 0.42, integratedLufs: -18.2 },
    });

    upsertSfxCatalogSound(catalogPath, entry);
    const catalog = loadSfxCatalog(catalogPath);
    assert.equal(catalog.sounds.length, 1);
    assert.equal(catalog.sounds[0].sfxId, "pixabay_sfx_123456");
    assert.equal(catalog.sounds[0].category, "transition");
    assert.throws(() => upsertSfxCatalogSound(catalogPath, entry), /już istnieje/);
  });
});

describe("deriveEditorialTags", () => {
  it("maps applause to reaction category", () => {
    const tags = deriveEditorialTags({ title: "Short Applause", rawTags: ["Applause", "Crowd"] });
    assert.ok(tags.includes("applause"));
    assert.equal(
      deriveSfxCategory({ title: "Short Applause", rawTags: ["Applause"], editorialTags: tags }),
      "reaction",
    );
  });
});
