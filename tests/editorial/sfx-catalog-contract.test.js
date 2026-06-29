import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CATALOG_PATH = path.join(REPO_ROOT, "assets", "sfx", "catalog.json");
const SFX_DIR = path.join(REPO_ROOT, "assets", "sfx");

const REQUIRED_SOUND_FIELDS = [
  "sfxId",
  "fileName",
  "title",
  "tags",
  "category",
  "durationSec",
  "license",
];

describe("sfx catalog contract", () => {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));

  it("has version and sounds array", () => {
    assert.equal(typeof catalog.version, "string");
    assert.ok(catalog.version.length > 0);
    assert.ok(Array.isArray(catalog.sounds));
    assert.ok(catalog.sounds.length > 0);
  });

  for (const field of REQUIRED_SOUND_FIELDS) {
    it(`every sound entry has required field: ${field}`, () => {
      for (const sound of catalog.sounds) {
        assert.ok(
          Object.hasOwn(sound, field),
          `sound ${sound.sfxId ?? "(unknown)"} missing ${field}`,
        );
        assert.notEqual(sound[field], null);
        assert.notEqual(sound[field], undefined);
      }
    });
  }

  it("sound entries have unique sfxId values", () => {
    const ids = catalog.sounds.map((s) => s.sfxId);
    assert.equal(new Set(ids).size, ids.length, `duplicate sfxId in ${ids.join(", ")}`);
  });

  it("every catalog fileName exists under assets/sfx/", () => {
    for (const sound of catalog.sounds) {
      const filePath = path.join(SFX_DIR, sound.fileName);
      assert.ok(fs.existsSync(filePath), `missing audio file: ${sound.fileName}`);
    }
  });

  it("license fields match LICENSES.md stub registry", () => {
    for (const sound of catalog.sounds) {
      assert.equal(
        sound.license,
        "repo-generated-test-stub",
        `${sound.sfxId} license should match LICENSES.md`,
      );
    }
  });

  it("sound field types match expected shape", () => {
    const allowedCategories = new Set(["transition", "foley", "reaction", "ambience"]);
    for (const sound of catalog.sounds) {
      assert.equal(typeof sound.sfxId, "string");
      assert.equal(typeof sound.fileName, "string");
      assert.ok(sound.fileName.endsWith(".wav") || sound.fileName.endsWith(".mp3"));
      assert.ok(Array.isArray(sound.tags) && sound.tags.length > 0);
      assert.ok(sound.tags.every((tag) => typeof tag === "string"));
      assert.ok(allowedCategories.has(sound.category), `${sound.sfxId} category: ${sound.category}`);
      assert.equal(typeof sound.durationSec, "number");
      assert.ok(sound.durationSec > 0);
    }
  });
});
