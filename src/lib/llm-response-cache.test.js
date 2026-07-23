import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  buildLlmCacheFileName,
  clearSummarizerAbstractLlmCache,
  isLlmReuseEnabled,
  parseAgentSchema,
  tryReadLlmResponseCache,
  writeLlmResponseCache,
} from "./llm-response-cache.js";

describe("llm-response-cache", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("buildLlmCacheFileName includes optional cacheKey", () => {
    assert.equal(
      buildLlmCacheFileName({ step: "segment_director", role: "segmentDirector", cacheKey: "seg001" }),
      "segment_director__segmentDirector__seg001.json",
    );
  });

  it("writes and reads cache only when reuse is enabled", () => {
    const response = { ok: true };
    writeLlmResponseCache({
      batchId: "abc12345",
      workDir: tmpDir,
      step: "super_director",
      role: "superDirector",
      response,
      model: "gpt-5.4-mini",
    });

    assert.equal(tryReadLlmResponseCache({
      batchId: "abc12345",
      workDir: tmpDir,
      step: "super_director",
      role: "superDirector",
      env: { LLM_REUSE_CACHE: "0" },
    }), null);

    const cached = tryReadLlmResponseCache({
      batchId: "abc12345",
      workDir: tmpDir,
      step: "super_director",
      role: "superDirector",
      env: { LLM_REUSE_CACHE: "1" },
    });
    assert.deepEqual(cached.response, response);
  });

  it("isLlmReuseEnabled reads env flag", () => {
    assert.equal(isLlmReuseEnabled({ LLM_REUSE_CACHE: "1" }), true);
    assert.equal(isLlmReuseEnabled({}), false);
  });

  it("parseAgentSchema persists rejected sidecar on Zod failure", () => {
    const schema = z.object({ notes: z.array(z.string()) });
    const raw = { notes: [1, 2] };

    assert.throws(() => {
      parseAgentSchema(schema, raw, {
        batchId: "abc12345",
        workDir: tmpDir,
        step: "super_director",
        role: "superDirector",
      });
    }, (error) => {
      assert.ok(error.llmRejectionPath);
      assert.ok(fs.existsSync(error.llmRejectionPath));
      const rejected = JSON.parse(fs.readFileSync(error.llmRejectionPath, "utf8"));
      assert.equal(rejected.cachePath.includes("llm-cache"), true);
      assert.ok(rejected.issues.length > 0);
      return true;
    });
  });

  it("clearSummarizerAbstractLlmCache removes L1/L2 only, keeps director caches", () => {
    const cacheDir = path.join(tmpDir, "llm-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const keep = [
      "abstract__summarizerL3.json",
      "direct__segmentDirector__seg001.json",
      "drill_down__directorDrillDown__drill_down.json",
    ];
    const remove = [
      "abstract__summarizerL1.json",
      "abstract__summarizerL1__clip01_scene001.json",
      "abstract__summarizerL1__batch_abcd.json",
      "abstract__summarizerL1__clip01_scene001__rejected.json",
      "abstract__summarizerL2__seg001.json",
    ];
    for (const name of [...keep, ...remove]) {
      fs.writeFileSync(path.join(cacheDir, name), "{}\n");
    }

    const deleted = clearSummarizerAbstractLlmCache(tmpDir);
    assert.deepEqual(deleted.sort(), remove.sort());
    for (const name of keep) {
      assert.ok(fs.existsSync(path.join(cacheDir, name)), `expected to keep ${name}`);
    }
    for (const name of remove) {
      assert.equal(fs.existsSync(path.join(cacheDir, name)), false, `expected deleted ${name}`);
    }
  });
});
