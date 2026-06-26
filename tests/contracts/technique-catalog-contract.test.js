import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TECHNIQUES_DIR = path.join(ROOT, "techniques");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("technique-catalog contract", () => {
  const meta = readJson(path.join(TECHNIQUES_DIR, "catalog.meta.json"));
  const techniqueSchema = readJson(path.join(TECHNIQUES_DIR, "_schema.json"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateTechnique = ajv.compile(techniqueSchema);

  it("catalog.meta.json lists every technique file on disk", () => {
    for (const relativePath of meta.techniqueFiles) {
      const filePath = path.join(TECHNIQUES_DIR, relativePath);
      assert.ok(fs.existsSync(filePath), `Missing technique file: ${relativePath}`);
    }
  });

  for (const relativePath of meta.techniqueFiles) {
    it(`technique ${relativePath} validates against _schema.json`, () => {
      const technique = readJson(path.join(TECHNIQUES_DIR, relativePath));
      const valid = validateTechnique(technique);
      assert.equal(
        valid,
        true,
        `${relativePath}: ${ajv.errorsText(validateTechnique.errors)}`,
      );
      assert.ok(typeof technique.id === "string");
      assert.ok(technique.id.length > 0);
    });
  }

  for (const relativePath of meta.packFiles) {
    it(`pack ${relativePath} references only known techniques`, () => {
      const pack = readJson(path.join(TECHNIQUES_DIR, relativePath));
      assert.ok(typeof pack.id === "string");
      assert.ok(Array.isArray(pack.enabledTechniqueIds));
      assert.ok(pack.enabledTechniqueIds.length > 0);

      const knownIds = new Set(
        meta.techniqueFiles.map((file) => readJson(path.join(TECHNIQUES_DIR, file)).id),
      );

      for (const techniqueId of pack.enabledTechniqueIds) {
        assert.ok(
          knownIds.has(techniqueId),
          `Pack ${pack.id} references unknown technique: ${techniqueId}`,
        );
      }
    });
  }

  it("default pack loads via loadTechniqueCatalog()", () => {
    const catalog = loadTechniqueCatalog();
    assert.equal(catalog.packId, meta.defaultPack);
    assert.ok(catalog.techniques.length > 0);
    assert.ok(catalog.byId.size > 0);
  });

  for (const packFile of meta.packFiles) {
    const packId = path.basename(packFile, ".json");
    it(`loadTechniqueCatalog({ pack: "${packId}" }) resolves techniques`, () => {
      const catalog = loadTechniqueCatalog({ pack: packId });
      assert.ok(catalog.techniques.length > 0);
      for (const technique of catalog.techniques) {
        assert.ok(catalog.byId.has(technique.id));
      }
    });
  }
});
