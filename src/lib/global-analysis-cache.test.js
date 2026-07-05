import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildAnalysisCacheKey,
  getGlobalCachePath,
  isGlobalAnalysisCacheEnabled,
  readGlobalAnalysisCache,
  writeGlobalAnalysisCache,
} from "./global-analysis-cache.js";
import { getPipelineAnalysisVersion } from "./pipeline-analysis-version.js";

describe("global-analysis-cache", () => {
  let cacheRoot;
  let previousDisableEnv;

  before(() => {
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vea-global-cache-"));
    previousDisableEnv = process.env.DISABLE_GLOBAL_ANALYSIS_CACHE;
    delete process.env.DISABLE_GLOBAL_ANALYSIS_CACHE;
  });

  after(() => {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    if (previousDisableEnv === undefined) {
      delete process.env.DISABLE_GLOBAL_ANALYSIS_CACHE;
    } else {
      process.env.DISABLE_GLOBAL_ANALYSIS_CACHE = previousDisableEnv;
    }
  });

  it("isGlobalAnalysisCacheEnabled respects disabled flag and env", () => {
    assert.equal(isGlobalAnalysisCacheEnabled(), true);
    assert.equal(isGlobalAnalysisCacheEnabled({ disabled: true }), false);

    process.env.DISABLE_GLOBAL_ANALYSIS_CACHE = "1";
    assert.equal(isGlobalAnalysisCacheEnabled(), false);
    delete process.env.DISABLE_GLOBAL_ANALYSIS_CACHE;
  });

  it("buildAnalysisCacheKey is stable and version-sensitive", () => {
    const params = {
      step: "words",
      contentHash: "abc123",
      configFingerprint: "fp-1",
    };

    const keyA = buildAnalysisCacheKey(params);
    const keyB = buildAnalysisCacheKey(params);
    assert.equal(keyA, keyB);
    assert.match(keyA, /^[a-f0-9]{64}$/);

    const expected = createHash("sha256")
      .update([getPipelineAnalysisVersion(), params.step, params.contentHash, params.configFingerprint].join("\0"))
      .digest("hex");
    assert.equal(keyA, expected);
  });

  it("writeGlobalAnalysisCache stores envelope and readGlobalAnalysisCache validates it", () => {
    const params = {
      step: "vision",
      contentHash: "hash-vision",
      configFingerprint: "fp-vision",
      cacheRoot,
      data: { version: "1.0", captions: [{ sceneId: "scene001", caption: "test" }] },
      meta: { source: "unit-test" },
    };

    const written = writeGlobalAnalysisCache(params);
    assert.ok(written);
    assert.equal(written.pipelineAnalysisVersion, getPipelineAnalysisVersion());
    assert.equal(written.step, params.step);
    assert.equal(written.contentHash, params.contentHash);
    assert.equal(written.configFingerprint, params.configFingerprint);
    assert.ok(written.cachedAt);
    assert.deepEqual(written.meta, params.meta);

    const cacheKey = buildAnalysisCacheKey(params);
    assert.equal(
      getGlobalCachePath(params.step, cacheKey, cacheRoot),
      path.join(cacheRoot, params.step, `${cacheKey}.json`),
    );
    assert.ok(fs.existsSync(getGlobalCachePath(params.step, cacheKey, cacheRoot)));

    const read = readGlobalAnalysisCache(params);
    assert.deepEqual(read, written);
  });

  it("readGlobalAnalysisCache returns null for mismatched envelope fields", () => {
    const params = {
      step: "words",
      contentHash: "hash-words",
      configFingerprint: "fp-words",
      cacheRoot,
      data: { version: "1.0", words: [] },
    };

    writeGlobalAnalysisCache(params);

    assert.equal(
      readGlobalAnalysisCache({ ...params, contentHash: "other-hash" }),
      null,
    );
    assert.equal(
      readGlobalAnalysisCache({ ...params, configFingerprint: "other-fp" }),
      null,
    );
    assert.equal(
      readGlobalAnalysisCache({ ...params, step: "vision" }),
      null,
    );
  });

  it("read/write return null when cache is disabled", () => {
    const params = {
      step: "faces",
      contentHash: "hash-faces",
      configFingerprint: "fp-faces",
      cacheRoot,
      data: { version: "1.0", detections: [] },
      disabled: true,
    };

    assert.equal(writeGlobalAnalysisCache(params), null);
    assert.equal(readGlobalAnalysisCache(params), null);
  });
});
