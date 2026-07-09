import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WHISPER_AUDIT_CATEGORIES,
  loadWhisperAuditCatalog,
  loadWhisperAuditCase,
  runWhisperBenchmark,
} from "../../src/lib/whisper-benchmark.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AUDIT_ROOT = path.join(REPO_ROOT, "fixtures", "whisper-audit");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("whisper-audit contract", () => {
  const catalog = loadWhisperAuditCatalog(REPO_ROOT);

  it("catalog has version and cases array", () => {
    assert.equal(catalog.version, "1.0");
    assert.ok(Array.isArray(catalog.cases));
    assert.equal(catalog.cases.length, 7);
  });

  for (const entry of catalog.cases) {
    it(`case ${entry.caseId} has required files and fields`, () => {
      assert.ok(WHISPER_AUDIT_CATEGORIES.has(entry.category), `invalid category: ${entry.category}`);
      assert.equal(typeof entry.caseId, "string");
      assert.equal(typeof entry.dir, "string");

      const caseDir = path.join(AUDIT_ROOT, entry.dir);
      assert.ok(fs.existsSync(caseDir), `missing case dir: ${entry.dir}`);

      const caseJsonPath = path.join(caseDir, "case.json");
      const expectedJsonPath = path.join(caseDir, "expected.json");
      const whisperResponsePath = path.join(caseDir, "whisper-response.json");
      assert.ok(fs.existsSync(caseJsonPath));
      assert.ok(fs.existsSync(expectedJsonPath));
      assert.ok(fs.existsSync(whisperResponsePath), `missing whisper-response.json for ${entry.caseId}`);

      const caseDef = readJson(caseJsonPath);
      const expected = readJson(expectedJsonPath);

      assert.equal(caseDef.caseId, entry.caseId);
      assert.equal(caseDef.category, entry.category);
      assert.equal(typeof caseDef.spokenTranscript, "string");
      assert.ok(caseDef.spokenTranscript.trim().length > 0);
      assert.equal(expected.tokenPolicy, "wordCore");
      assert.equal(typeof expected.allowEmptyWords, "boolean");
    });

    it(`case ${entry.caseId} loads via loadWhisperAuditCase`, () => {
      const loaded = loadWhisperAuditCase(entry.caseId, REPO_ROOT);
      assert.equal(loaded.caseId, entry.caseId);
      assert.ok(loaded.expected);
    });
  }

  it("catalog caseIds are unique", () => {
    const ids = catalog.cases.map((entry) => entry.caseId);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("all fixture cases pass via runWhisperBenchmark", async () => {
    const report = await runWhisperBenchmark({ mode: "fixture", repoRoot: REPO_ROOT });
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.pending, 0);
    assert.equal(report.summary.pass, catalog.cases.length);
  });
});
