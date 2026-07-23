import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXPECTED_ARTIFACT_VERSIONS,
  getManifestClipHash,
  isClipArtifactContentStale,
  isClipArtifactVersionStale,
  resolveClipContentHash,
  shouldUseCachedClipArtifactExtended,
} from "./clip-artifact-cache.js";
import { computeSourceContentHash } from "./source-hash.js";
import { ARTIFACTS, writeJson } from "../pipeline/work-paths.js";

function touch(filePath, offsetMs = 0) {
  const mtime = (Date.now() - 10_000 + offsetMs) / 1000;
  fs.utimesSync(filePath, mtime, mtime);
}

describe("clip-artifact-cache", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-clip-artifact-cache-"));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("exports expected artifact versions", () => {
    assert.equal(EXPECTED_ARTIFACT_VERSIONS.twelvelabs, "1.1");
    assert.equal(EXPECTED_ARTIFACT_VERSIONS.words, "1.1");
  });

  it("getManifestClipHash reads contentHash by clipId or clip index", () => {
    const manifest = {
      clips: [
        { clipId: "clip01", contentHash: "hash-a" },
        { clipId: "clip02", contentHash: "hash-b" },
      ],
    };

    assert.equal(getManifestClipHash(manifest, "clip01"), "hash-a");
    assert.equal(getManifestClipHash(manifest, "clip02"), "hash-b");
    assert.equal(getManifestClipHash(manifest, "clip99"), null);
  });

  it("getManifestClipHash falls back to clip index when clipId is absent", () => {
    const manifest = {
      clips: [
        { contentHash: "hash-a" },
        { contentHash: "hash-b" },
      ],
    };

    assert.equal(getManifestClipHash(manifest, "clip01"), "hash-a");
    assert.equal(getManifestClipHash(manifest, "clip02"), "hash-b");
  });

  it("resolveClipContentHash prefers manifest hash over file hash", async () => {
    const manifest = { clips: [{ clipId: "clip01", contentHash: "manifest-hash" }] };
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-resolve-hash-"));
    const sourcePath = path.join(workDir, "clip.mp4");
    fs.writeFileSync(sourcePath, "video bytes");

    try {
      const fileHash = await computeSourceContentHash(sourcePath);
      assert.notEqual(fileHash, "manifest-hash");

      assert.equal(
        await resolveClipContentHash(manifest, "clip01", sourcePath),
        "manifest-hash",
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("resolveClipContentHash falls back to computeSourceContentHash", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-resolve-hash-fallback-"));
    const sourcePath = path.join(workDir, "clip.mp4");
    fs.writeFileSync(sourcePath, "video bytes");

    try {
      const fileHash = await computeSourceContentHash(sourcePath);
      assert.equal(await resolveClipContentHash(null, "clip01", sourcePath), fileHash);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("isClipArtifactContentStale detects hash mismatch and missing artifact hash", () => {
    const manifest = { clips: [{ clipId: "clip01", contentHash: "current-hash" }] };

    assert.equal(
      isClipArtifactContentStale({
        manifest,
        clipId: "clip01",
        artifact: { sourceContentHash: "current-hash" },
      }),
      false,
    );

    assert.equal(
      isClipArtifactContentStale({
        manifest,
        clipId: "clip01",
        artifact: { sourceContentHash: "old-hash" },
      }),
      true,
    );

    assert.equal(
      isClipArtifactContentStale({
        manifest,
        clipId: "clip01",
        artifact: { version: "1.0" },
      }),
      true,
    );
  });

  it("isClipArtifactVersionStale compares against expected versions", () => {
    assert.equal(
      isClipArtifactVersionStale({
        artifactName: "twelvelabs",
        artifact: { version: "1.0" },
      }),
      true,
    );

    assert.equal(
      isClipArtifactVersionStale({
        artifactName: "twelvelabs",
        artifact: { version: "1.1" },
      }),
      false,
    );

    assert.equal(
      isClipArtifactVersionStale({
        artifactName: "twelvelabs",
        artifact: { version: "1.0", indexingStatus: "stub" },
      }),
      false,
      "stub twelvelabs at 1.0 should not be version-stale",
    );
  });

  it("shouldUseCachedClipArtifactExtended rejects stale content, version, and live stub artifacts", () => {
    const manifest = {
      clips: [{ clipId: "clip01", contentHash: "manifest-hash" }],
    };
    const sceneCatalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);
    const outPath = path.join(workDir, ARTIFACTS.twelvelabs("clip01"));

    writeJson(sceneCatalogPath, { batchId: "b1", clips: [], scenes: [] });
    touch(sceneCatalogPath, 0);

    writeJson(outPath, {
      version: "1.1",
      clipId: "clip01",
      indexingStatus: "indexed",
      sourceContentHash: "manifest-hash",
      chapters: [],
      moments: [],
    });
    touch(outPath, 5000);

    assert.equal(
      shouldUseCachedClipArtifactExtended({
        workDir,
        outPath,
        force: false,
        manifest,
        clipId: "clip01",
      }),
      true,
    );

    writeJson(outPath, {
      version: "1.0",
      clipId: "clip01",
      indexingStatus: "indexed",
      sourceContentHash: "manifest-hash",
      chapters: [],
      moments: [],
    });
    touch(outPath, 5000);

    assert.equal(
      shouldUseCachedClipArtifactExtended({
        workDir,
        outPath,
        force: false,
        manifest,
        clipId: "clip01",
      }),
      false,
      "version below expected should invalidate cache",
    );

    writeJson(outPath, {
      version: "1.1",
      clipId: "clip01",
      indexingStatus: "stub",
      sourceContentHash: "manifest-hash",
      chapters: [],
      moments: [],
    });
    touch(outPath, 5000);

    assert.equal(
      shouldUseCachedClipArtifactExtended({
        workDir,
        outPath,
        force: false,
        manifest,
        clipId: "clip01",
        liveModeHints: { useStub: false },
      }),
      false,
      "stub artifact should be stale in live mode",
    );

    writeJson(outPath, {
      version: "1.1",
      clipId: "clip01",
      indexingStatus: "frame_analysis",
      sourceContentHash: "manifest-hash",
      chapters: [{ startSec: 0, endSec: 2, title: "Peak" }],
      moments: [],
    });
    touch(outPath, 5000);

    assert.equal(
      shouldUseCachedClipArtifactExtended({
        workDir,
        outPath,
        force: false,
        manifest,
        clipId: "clip01",
        liveModeHints: { useStub: false, twelvelabsLive: true },
      }),
      true,
      "frame_analysis artifact should be reusable in live mode",
    );

    writeJson(outPath, {
      version: "1.1",
      clipId: "clip01",
      indexingStatus: "indexed",
      sourceContentHash: "old-hash",
      chapters: [],
      moments: [],
    });
    touch(outPath, 5000);

    assert.equal(
      shouldUseCachedClipArtifactExtended({
        workDir,
        outPath,
        force: false,
        manifest,
        clipId: "clip01",
      }),
      false,
      "content hash mismatch should invalidate cache",
    );
  });
});
