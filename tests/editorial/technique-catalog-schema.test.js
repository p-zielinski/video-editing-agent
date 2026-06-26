import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TECHNIQUES_DIR = path.join(ROOT, "techniques");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("technique catalog JSON schema", () => {
  const meta = readJson(path.join(TECHNIQUES_DIR, "catalog.meta.json"));
  const techniqueSchema = readJson(path.join(TECHNIQUES_DIR, "_schema.json"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateTechnique = ajv.compile(techniqueSchema);

  for (const relativePath of meta.techniqueFiles) {
    it(`validates ${relativePath} against _schema.json`, () => {
      const technique = readJson(path.join(TECHNIQUES_DIR, relativePath));
      const valid = validateTechnique(technique);
      assert.equal(
        valid,
        true,
        `${relativePath}: ${ajv.errorsText(validateTechnique.errors)}`,
      );
    });
  }

  for (const relativePath of meta.packFiles) {
    it(`validates pack ${relativePath} structure`, () => {
      const pack = readJson(path.join(TECHNIQUES_DIR, relativePath));
      assert.ok(typeof pack.id === "string");
      assert.ok(Array.isArray(pack.enabledTechniqueIds));
      assert.ok(pack.enabledTechniqueIds.length > 0);
      if (pack.defaultCreativityLevel) {
        assert.ok(["safe", "balanced", "bold", "shorts"].includes(pack.defaultCreativityLevel));
      }
      if (pack.retentionDefaults) {
        assert.ok(typeof pack.retentionDefaults.hookWindowSec === "number");
        assert.ok(typeof pack.retentionDefaults.retentionBeatIntervalSec === "number");
      }
    });
  }
});
