import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ARTIFACT_DEPENDENCY_GRAPH,
  CLIP_ARTIFACT_PATTERNS,
  isSpatialIndexStale,
  isArtifactStale,
  getStaleDownstream,
  shouldRebuildArtifact,
  shouldUseCachedArtifact,
  shouldUseCachedClipArtifact,
  shouldUseCachedClipArtifactWithContext,
  listObjectArtifactPaths,
  SPATIAL_INDEX_INPUTS,
} from "./artifact-deps.js";
import { ARTIFACTS, writeJson } from "./work-paths.js";

function touch(filePath, offsetMs = 0) {
  const mtime = (Date.now() - 10_000 + offsetMs) / 1000;
  fs.utimesSync(filePath, mtime, mtime);
}

function writeArtifact(dir, name, data = { version: "1.0" }) {
  const filePath = path.join(dir, name);
  writeJson(filePath, data);
  return filePath;
}

describe("artifact-deps", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-artifact-deps-"));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("exports ARTIFACT_DEPENDENCY_GRAPH with all pre-render artifacts", () => {
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.manifest]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.timelineIndex]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.clipRegistry]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.abstraction]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.topicIndex]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.spatialIndex]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.recipeDraft]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.review]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH["01-words-*"]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH["01b-audio-analysis-*"]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.audioIndex]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH["04-objects-*"]);
    assert.ok(ARTIFACT_DEPENDENCY_GRAPH["04a-faces-*"]);
  });

  it("exports SPATIAL_INDEX_INPUTS aligned with spatial index graph entry", () => {
    assert.deepEqual(
      SPATIAL_INDEX_INPUTS,
      ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.spatialIndex],
    );
  });

  it("recipeDraft depends on metaCommands clip artifacts", () => {
    assert.ok(
      ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.recipeDraft].includes(
        CLIP_ARTIFACT_PATTERNS.metaCommands,
      ),
    );
  });

  it("review depends on audioEnhancementIndex", () => {
    assert.ok(
      ARTIFACT_DEPENDENCY_GRAPH[ARTIFACTS.review].includes(
        ARTIFACTS.audioEnhancementIndex,
      ),
    );
  });

  it("isArtifactStale returns true when artifact is missing", () => {
    assert.equal(isArtifactStale(workDir, ARTIFACTS.timelineIndex), true);
    assert.equal(isArtifactStale(workDir, ARTIFACTS.words("clip01")), true);
  });

  it("isArtifactStale returns false when artifact is newest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-fresh-tl-"));
    try {
      writeArtifact(dir, ARTIFACTS.sceneCatalog, { batchId: "b1", clips: [], scenes: [] });
      writeArtifact(dir, ARTIFACTS.timelineIndex, { batchId: "b1", scenes: [] });
      touch(path.join(dir, ARTIFACTS.sceneCatalog), 0);
      touch(path.join(dir, ARTIFACTS.timelineIndex), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.timelineIndex), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("timeline-index is stale when scene-catalog is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-tl-sc-"));
    try {
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      writeArtifact(dir, ARTIFACTS.sceneCatalog);
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.sceneCatalog), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.timelineIndex), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clip-registry is stale when timeline-index is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-cr-"));
    try {
      writeArtifact(dir, ARTIFACTS.sceneCatalog);
      writeArtifact(dir, ARTIFACTS.clipRegistry);
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      touch(path.join(dir, ARTIFACTS.sceneCatalog), 0);
      touch(path.join(dir, ARTIFACTS.clipRegistry), 0);
      touch(path.join(dir, ARTIFACTS.timelineIndex), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.clipRegistry), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clip-registry is stale when audio-analysis artifact is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-cr-audio-"));
    try {
      writeArtifact(dir, ARTIFACTS.sceneCatalog);
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      writeArtifact(dir, ARTIFACTS.audioIndex, { clips: [] });
      writeArtifact(dir, ARTIFACTS.clipRegistry, { clipRegistry: [] });
      writeArtifact(dir, ARTIFACTS.audioAnalysis("clip01"), { editorialTags: [] });
      touch(path.join(dir, ARTIFACTS.sceneCatalog), 0);
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.audioIndex), 0);
      touch(path.join(dir, ARTIFACTS.clipRegistry), 0);
      touch(path.join(dir, ARTIFACTS.audioAnalysis("clip01")), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.clipRegistry), true);
      assert.equal(shouldUseCachedArtifact(dir, ARTIFACTS.clipRegistry, false), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clip-registry is stale when audio-index is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-cr-audioidx-"));
    try {
      writeArtifact(dir, ARTIFACTS.sceneCatalog);
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      writeArtifact(dir, ARTIFACTS.clipRegistry, { clipRegistry: [] });
      writeArtifact(dir, ARTIFACTS.audioIndex, { clips: [] });
      touch(path.join(dir, ARTIFACTS.sceneCatalog), 0);
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.clipRegistry), 0);
      touch(path.join(dir, ARTIFACTS.audioIndex), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.clipRegistry), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("abstraction is stale when timeline-index is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-abs-"));
    try {
      writeArtifact(dir, ARTIFACTS.abstraction, { L1: [], L2: [], L3: {} });
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      touch(path.join(dir, ARTIFACTS.abstraction), 0);
      touch(path.join(dir, ARTIFACTS.timelineIndex), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.abstraction), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("topic-index is stale when objects artifact is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-topic-obj-"));
    try {
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      writeArtifact(dir, ARTIFACTS.clipRegistry, { clipRegistry: [] });
      writeArtifact(dir, ARTIFACTS.abstraction, { L1: [], L2: [], L3: {} });
      writeArtifact(dir, ARTIFACTS.topicIndex, { topics: [] });
      writeArtifact(dir, ARTIFACTS.objects("clip01"), { detections: [] });
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.clipRegistry), 0);
      touch(path.join(dir, ARTIFACTS.abstraction), 0);
      touch(path.join(dir, ARTIFACTS.topicIndex), 0);
      touch(path.join(dir, ARTIFACTS.objects("clip01")), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.topicIndex), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("topic-index is stale when twelvelabs artifact is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-topic-tl-"));
    try {
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      writeArtifact(dir, ARTIFACTS.clipRegistry, { clipRegistry: [] });
      writeArtifact(dir, ARTIFACTS.abstraction, { L1: [], L2: [], L3: {} });
      writeArtifact(dir, ARTIFACTS.topicIndex, { topics: [] });
      writeArtifact(dir, ARTIFACTS.twelvelabs("clip01"), { chapters: [], moments: [] });
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.clipRegistry), 0);
      touch(path.join(dir, ARTIFACTS.abstraction), 0);
      touch(path.join(dir, ARTIFACTS.topicIndex), 0);
      touch(path.join(dir, ARTIFACTS.twelvelabs("clip01")), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.topicIndex), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("topic-index is stale when abstraction is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-topic-"));
    try {
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      writeArtifact(dir, ARTIFACTS.clipRegistry, { clipRegistry: [] });
      writeArtifact(dir, ARTIFACTS.topicIndex, { topics: [] });
      writeArtifact(dir, ARTIFACTS.abstraction, { L1: [], L2: [], L3: {} });
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.clipRegistry), 0);
      touch(path.join(dir, ARTIFACTS.topicIndex), 0);
      touch(path.join(dir, ARTIFACTS.abstraction), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.topicIndex), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recipe-draft is stale when spatial-index is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-draft-"));
    try {
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      writeArtifact(dir, ARTIFACTS.abstraction, { L1: [], L2: [], L3: {} });
      writeArtifact(dir, ARTIFACTS.clipRegistry, { clipRegistry: [] });
      writeArtifact(dir, ARTIFACTS.topicIndex, { topics: [] });
      writeArtifact(dir, ARTIFACTS.recipeDraft, { outputs: [] });
      writeArtifact(dir, ARTIFACTS.spatialIndex, { scenes: [] });
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.abstraction), 0);
      touch(path.join(dir, ARTIFACTS.clipRegistry), 0);
      touch(path.join(dir, ARTIFACTS.topicIndex), 0);
      touch(path.join(dir, ARTIFACTS.recipeDraft), 0);
      touch(path.join(dir, ARTIFACTS.spatialIndex), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.recipeDraft), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("per-clip keyframes stale when matching words artifact is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-kf-"));
    try {
      writeArtifact(dir, ARTIFACTS.sceneCatalog, { clips: [{ clipId: "clip01" }], scenes: [] });
      writeArtifact(dir, ARTIFACTS.words("clip01"), { words: [] });
      writeArtifact(dir, ARTIFACTS.keyframes("clip01"), { keyframes: [] });
      touch(path.join(dir, ARTIFACTS.sceneCatalog), 0);
      touch(path.join(dir, ARTIFACTS.keyframes("clip01")), 0);
      touch(path.join(dir, ARTIFACTS.words("clip01")), 5000);

      assert.equal(isArtifactStale(dir, ARTIFACTS.keyframes("clip01")), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is stale when spatial index is missing", () => {
    assert.equal(isSpatialIndexStale(workDir), true);
    assert.equal(isArtifactStale(workDir, ARTIFACTS.spatialIndex), true);
  });

  it("is stale when timeline index is newer than spatial index", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-tl-"));
    try {
      writeArtifact(dir, ARTIFACTS.spatialIndex, { scenes: [] });
      writeArtifact(dir, ARTIFACTS.timelineIndex, { scenes: [] });
      touch(path.join(dir, ARTIFACTS.spatialIndex), 0);
      touch(path.join(dir, ARTIFACTS.timelineIndex), 5000);

      assert.equal(isSpatialIndexStale(dir), true);
      assert.equal(isArtifactStale(dir, ARTIFACTS.spatialIndex), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is stale when objects artifact is newer than spatial index", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-obj-"));
    try {
      writeArtifact(dir, ARTIFACTS.spatialIndex, { scenes: [] });
      writeArtifact(dir, ARTIFACTS.timelineIndex, { scenes: [] });
      writeArtifact(dir, ARTIFACTS.objects("clip01"), { detections: [] });
      touch(path.join(dir, ARTIFACTS.spatialIndex), 0);
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.objects("clip01")), 5000);

      assert.equal(isSpatialIndexStale(dir), true);
      assert.equal(isArtifactStale(dir, ARTIFACTS.spatialIndex), true);
      assert.equal(listObjectArtifactPaths(dir).length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is stale when faces artifact is newer than spatial index", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-stale-face-"));
    try {
      writeArtifact(dir, ARTIFACTS.spatialIndex, { scenes: [] });
      writeArtifact(dir, ARTIFACTS.timelineIndex, { scenes: [] });
      writeArtifact(dir, ARTIFACTS.faces("clip01"), { detections: [] });
      touch(path.join(dir, ARTIFACTS.spatialIndex), 0);
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.faces("clip01")), 5000);

      assert.equal(isSpatialIndexStale(dir), true);
      assert.equal(isArtifactStale(dir, ARTIFACTS.spatialIndex), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is fresh when spatial index is newest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-fresh-"));
    try {
      writeArtifact(dir, ARTIFACTS.timelineIndex, { scenes: [] });
      writeArtifact(dir, ARTIFACTS.objects("clip01"), { detections: [] });
      writeArtifact(dir, ARTIFACTS.spatialIndex, { scenes: [] });
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.objects("clip01")), 0);
      touch(path.join(dir, ARTIFACTS.spatialIndex), 5000);

      assert.equal(isSpatialIndexStale(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getStaleDownstream from objects includes spatial-index and topic-index", () => {
    const downstream = getStaleDownstream(ARTIFACTS.objects("clip01"));
    assert.ok(downstream.includes(ARTIFACTS.spatialIndex));
    assert.ok(downstream.includes(ARTIFACTS.topicIndex));
  });

  it("getStaleDownstream returns transitive dependents of timeline-index", () => {
    const downstream = getStaleDownstream(ARTIFACTS.timelineIndex);
    assert.ok(downstream.includes(ARTIFACTS.clipRegistry));
    assert.ok(downstream.includes(ARTIFACTS.abstraction));
    assert.ok(downstream.includes(ARTIFACTS.topicIndex));
    assert.ok(downstream.includes(ARTIFACTS.spatialIndex));
    assert.ok(downstream.includes(ARTIFACTS.recipeDraft));
    assert.ok(downstream.includes(ARTIFACTS.review));
  });

  it("getStaleDownstream from abstraction includes topic-index and recipe-draft", () => {
    const downstream = getStaleDownstream(ARTIFACTS.abstraction);
    assert.ok(downstream.includes(ARTIFACTS.topicIndex));
    assert.ok(downstream.includes(ARTIFACTS.recipeDraft));
    assert.ok(!downstream.includes(ARTIFACTS.timelineIndex));
  });

  it("shouldRebuildArtifact respects force flag", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-force-"));
    try {
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      writeArtifact(dir, ARTIFACTS.abstraction);
      touch(path.join(dir, ARTIFACTS.abstraction), 0);
      touch(path.join(dir, ARTIFACTS.timelineIndex), 5000);

      assert.equal(shouldRebuildArtifact(dir, ARTIFACTS.abstraction, false), true);
      assert.equal(shouldRebuildArtifact(dir, ARTIFACTS.abstraction, true), true);
      assert.equal(shouldUseCachedArtifact(dir, ARTIFACTS.abstraction, true), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shouldUseCachedArtifact returns true for fresh artifacts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-cache-"));
    try {
      writeArtifact(dir, ARTIFACTS.timelineIndex);
      writeArtifact(dir, ARTIFACTS.abstraction, { L1: [], L2: [], L3: {} });
      touch(path.join(dir, ARTIFACTS.timelineIndex), 0);
      touch(path.join(dir, ARTIFACTS.abstraction), 5000);

      assert.equal(shouldUseCachedArtifact(dir, ARTIFACTS.abstraction, false), true);
      assert.equal(shouldRebuildArtifact(dir, ARTIFACTS.abstraction, false), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("shouldUseCachedClipArtifact extended checks", () => {
    function setupFreshTwelvelabsArtifact(dir, artifactData) {
      const manifest = {
        clips: [{ clipId: "clip01", contentHash: "manifest-hash" }],
      };
      const sceneCatalogPath = path.join(dir, ARTIFACTS.sceneCatalog);
      const manifestPath = path.join(dir, ARTIFACTS.manifest);
      const outPath = path.join(dir, ARTIFACTS.twelvelabs("clip01"));

      writeJson(manifestPath, manifest);
      writeJson(sceneCatalogPath, { batchId: "b1", clips: [{ clipId: "clip01" }], scenes: [] });
      writeJson(outPath, artifactData);
      touch(manifestPath, 0);
      touch(sceneCatalogPath, 0);
      touch(outPath, 5000);

      return { manifest, outPath };
    }

    it("returns false when manifest contentHash differs from artifact sourceContentHash", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-clip-hash-stale-"));
      try {
        const { manifest, outPath } = setupFreshTwelvelabsArtifact(dir, {
          version: "1.1",
          clipId: "clip01",
          indexingStatus: "indexed",
          sourceContentHash: "old-hash",
          chapters: [],
          moments: [],
        });

        assert.equal(
          shouldUseCachedClipArtifactWithContext({
            workDir: dir,
            outPath,
            force: false,
            manifest,
            clipId: "clip01",
          }),
          false,
        );

        assert.equal(
          shouldUseCachedClipArtifact(dir, outPath, false, { manifest, clipId: "clip01" }),
          false,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns false when twelvelabs artifact version is 1.0 but expected 1.1", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-clip-version-stale-"));
      try {
        const { manifest, outPath } = setupFreshTwelvelabsArtifact(dir, {
          version: "1.0",
          clipId: "clip01",
          indexingStatus: "indexed",
          sourceContentHash: "manifest-hash",
          chapters: [],
          moments: [],
        });

        assert.equal(
          shouldUseCachedClipArtifactWithContext({
            workDir: dir,
            outPath,
            force: false,
            manifest,
            clipId: "clip01",
          }),
          false,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns false when twelvelabsLive is true and artifact indexingStatus is stub", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-clip-stub-stale-"));
      try {
        const { manifest, outPath } = setupFreshTwelvelabsArtifact(dir, {
          version: "1.1",
          clipId: "clip01",
          indexingStatus: "stub",
          sourceContentHash: "manifest-hash",
          chapters: [],
          moments: [],
        });

        assert.equal(
          shouldUseCachedClipArtifactWithContext({
            workDir: dir,
            outPath,
            force: false,
            manifest,
            clipId: "clip01",
            liveModeHints: { twelvelabsLive: true },
          }),
          false,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reads manifest from workDir for hash checks when options omit manifest", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-clip-manifest-read-"));
      try {
        const { outPath } = setupFreshTwelvelabsArtifact(dir, {
          version: "1.1",
          clipId: "clip01",
          indexingStatus: "indexed",
          sourceContentHash: "old-hash",
          chapters: [],
          moments: [],
        });

        assert.equal(shouldUseCachedClipArtifact(dir, outPath, false), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    function setupFreshWordsArtifact(dir, artifactData) {
      const manifest = {
        clips: [{ clipId: "clip01", contentHash: "manifest-hash" }],
      };
      const sceneCatalogPath = path.join(dir, ARTIFACTS.sceneCatalog);
      const manifestPath = path.join(dir, ARTIFACTS.manifest);
      const outPath = path.join(dir, ARTIFACTS.words("clip01"));

      writeJson(manifestPath, manifest);
      writeJson(sceneCatalogPath, { batchId: "b1", clips: [{ clipId: "clip01" }], scenes: [] });
      writeJson(outPath, artifactData);
      touch(manifestPath, 0);
      touch(sceneCatalogPath, 0);
      touch(outPath, 5000);

      return { manifest, outPath };
    }

    it("returns false for words artifact when manifest contentHash differs", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-words-hash-stale-"));
      try {
        const { manifest, outPath } = setupFreshWordsArtifact(dir, {
          version: "1.1",
          clipId: "clip01",
          sourceContentHash: "old-hash",
          words: [],
          durationSec: 10,
        });

        assert.equal(
          shouldUseCachedClipArtifact(dir, outPath, false, { manifest, clipId: "clip01" }),
          false,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns true for words artifact when hash matches and mtime graph is fresh", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-words-hash-fresh-"));
      try {
        const { manifest, outPath } = setupFreshWordsArtifact(dir, {
          version: "1.1",
          clipId: "clip01",
          sourceContentHash: "manifest-hash",
          words: [],
          durationSec: 10,
        });

        assert.equal(
          shouldUseCachedClipArtifact(dir, outPath, false, { manifest, clipId: "clip01" }),
          true,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
