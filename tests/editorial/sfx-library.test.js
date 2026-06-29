import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSfxCatalog,
  listSfxCatalog,
  resolveSfxById,
  resolveSfxByTag,
  resetSfxCatalogCache,
} from "../../src/editorial/sfx-library.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WHOOSH_WAV = path.join(REPO_ROOT, "assets", "sfx", "whoosh.wav");

function createTempCatalog(sound, { createFile = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-lib-"));
  const filePath = path.join(tmpDir, sound.fileName);
  if (createFile) {
    fs.writeFileSync(filePath, "");
  }
  const catalogPath = path.join(tmpDir, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({
    version: "1.0",
    sounds: [sound],
  }));
  return {
    catalogPath,
    cleanup: () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resetSfxCatalogCache();
    },
  };
}

describe("sfx-library", () => {
  it("loads the repo catalog", () => {
    resetSfxCatalogCache();
    const catalog = loadSfxCatalog();
    assert.equal(catalog.version, "1.0");
    assert.ok(catalog.sounds.length >= 9);
    assert.ok(catalog.sounds.some((entry) => entry.sfxId === "whoosh"));
  });

  it("lists catalog sounds", () => {
    resetSfxCatalogCache();
    const sounds = listSfxCatalog();
    assert.ok(sounds.some((entry) => entry.sfxId === "impact_heavy_01"));
    assert.ok(sounds.some((entry) => entry.sfxId === "applause_short_01"));
  });

  it("resolveSfxById returns whoosh when repo file exists", () => {
    assert.equal(fs.existsSync(WHOOSH_WAV), true);
    resetSfxCatalogCache();
    const result = resolveSfxById("whoosh");
    assert.equal(result.sound?.sfxId, "whoosh");
    assert.equal(result.sound?.fileName, "whoosh.wav");
    assert.equal(result.reason, null);
  });


  it("resolveSfxById resolves all repo catalog entries when files exist", () => {
    resetSfxCatalogCache();
    const sounds = listSfxCatalog();
    assert.ok(sounds.length >= 9);
    for (const entry of sounds) {
      const result = resolveSfxById(entry.sfxId);
      assert.equal(result.reason, null, `expected ${entry.sfxId} to resolve`);
      assert.equal(result.sound?.sfxId, entry.sfxId);
      assert.equal(result.sound?.fileName, entry.fileName);
      const filePath = path.join(REPO_ROOT, "assets", "sfx", entry.fileName);
      assert.equal(fs.existsSync(filePath), true, `missing ${entry.fileName}`);
    }
  });

  it("resolveSfxByTag returns first tag match when file exists", () => {
    resetSfxCatalogCache();
    const result = resolveSfxByTag("whoosh");
    assert.equal(result.sound?.sfxId, "whoosh");
    assert.equal(result.reason, null);
  });

  it("resolveSfxByTag resolves laughter and click stubs", () => {
    resetSfxCatalogCache();
    const laughter = resolveSfxByTag("laughter");
    assert.equal(laughter.sound?.sfxId, "laughter_short_01");
    assert.equal(laughter.reason, null);

    const click = resolveSfxByTag("click");
    assert.equal(click.sound?.sfxId, "click_short_01");
    assert.equal(click.reason, null);
  });

  it("resolveSfxById returns null when file is missing", () => {
    const { catalogPath, cleanup } = createTempCatalog({
      sfxId: "impact_heavy_01",
      fileName: "impact_heavy_01.wav",
      tags: ["impact"],
    }, { createFile: false });
    try {
      resetSfxCatalogCache();
      const result = resolveSfxById("impact_heavy_01", { catalogPath });
      assert.equal(result.sound, null);
      assert.equal(result.reason, "sfx_file_missing");
    } finally {
      cleanup();
    }
  });

  it("resolveSfxByTag returns null when file is missing", () => {
    const { catalogPath, cleanup } = createTempCatalog({
      sfxId: "applause_short_01",
      fileName: "applause_short_01.wav",
      tags: ["applause"],
    }, { createFile: false });
    try {
      resetSfxCatalogCache();
      const result = resolveSfxByTag("applause", { catalogPath });
      assert.equal(result.sound, null);
      assert.equal(result.reason, "sfx_file_missing");
    } finally {
      cleanup();
    }
  });
});
