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
    assert.ok(Array.isArray(catalog.sounds));
  });

  it("lists catalog sounds", () => {
    resetSfxCatalogCache();
    const sounds = listSfxCatalog();
    assert.ok(Array.isArray(sounds));
  });

  it("resolveSfxById returns whoosh when repo file exists", () => {
    if (!fs.existsSync(WHOOSH_WAV)) {
      return;
    }
    resetSfxCatalogCache();
    const result = resolveSfxById("whoosh");
    assert.equal(result.sound?.sfxId, "whoosh");
    assert.equal(result.sound?.fileName, "whoosh.wav");
    assert.equal(result.reason, null);
  });


  it("resolveSfxById resolves all repo catalog entries when files exist", () => {
    resetSfxCatalogCache();
    const sounds = listSfxCatalog();
    if (sounds.length === 0) {
      return;
    }
    for (const entry of sounds) {
      const result = resolveSfxById(entry.sfxId);
      const filePath = path.join(REPO_ROOT, "assets", "sfx", entry.fileName);
      if (!fs.existsSync(filePath)) {
        assert.equal(result.reason, "sfx_file_missing");
        continue;
      }
      assert.equal(result.reason, null, `expected ${entry.sfxId} to resolve`);
      assert.equal(result.sound?.sfxId, entry.sfxId);
      assert.equal(result.sound?.fileName, entry.fileName);
    }
  });

  it("resolveSfxByTag returns first tag match when file exists", () => {
    if (!fs.existsSync(WHOOSH_WAV)) {
      return;
    }
    resetSfxCatalogCache();
    const result = resolveSfxByTag("whoosh");
    assert.equal(result.sound?.sfxId, "whoosh");
    assert.equal(result.reason, null);
  });

  it("resolveSfxByTag resolves laughter and click stubs", () => {
    const { catalogPath, cleanup } = createTempCatalog({
      sfxId: "laughter_short_01",
      fileName: "laughter_short_01.wav",
      tags: ["laughter", "reaction"],
    });
    const { catalogPath: catalogPath2, cleanup: cleanup2 } = createTempCatalog({
      sfxId: "click_short_01",
      fileName: "click_short_01.wav",
      tags: ["click", "ui"],
    });
    try {
      resetSfxCatalogCache();
      const laughter = resolveSfxByTag("laughter", { catalogPath });
      assert.equal(laughter.sound?.sfxId, "laughter_short_01");
      assert.equal(laughter.reason, null);

      const click = resolveSfxByTag("click", { catalogPath: catalogPath2 });
      assert.equal(click.sound?.sfxId, "click_short_01");
      assert.equal(click.reason, null);
    } finally {
      cleanup();
      cleanup2();
    }
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
