import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildBatchQualityReport,
  formatBatchQualitySummary,
  writeBatchQualityReport,
} from "./batch-quality-report.js";
import { ARTIFACTS, writeJson } from "../pipeline/work-paths.js";
import { buildProvenanceDocument } from "./recipe-provenance.js";

describe("batch_quality_report", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-quality-"));
  });

  beforeEach(() => {
    for (const entry of fs.readdirSync(workDir)) {
      fs.rmSync(path.join(workDir, entry), { recursive: true, force: true });
    }
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("computes anchor and speech metrics from artifacts", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch01",
      scenes: [
        { sceneId: "clip01_scene001" },
        { sceneId: "clip01_scene002" },
      ],
      words: [
        { word: "cześć", isFiller: false },
        { word: "yyy", isFiller: true },
      ],
      stats: { totalWords: 2, fillerWordCount: 1 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch01",
      scenes: [
        { sceneId: "clip01_scene001", anchors: [{ type: "face", bbox: [0, 0, 0.1, 0.1], timestampSec: 0, label: "face", confidence: 0.5 }] },
        { sceneId: "clip01_scene002", anchors: [] },
      ],
    });
    writeJson(path.join(workDir, ARTIFACTS.abstraction), {
      L1: [
        { sceneId: "clip01_scene001", brollPotential: 0.2 },
        { sceneId: "clip01_scene002", brollPotential: 0.4 },
      ],
    });
    writeJson(path.join(workDir, ARTIFACTS.topicIndex), {
      topics: [
        {
          topicId: "topic_001",
          matchingScenes: [{ sceneId: "clip02_scene001", score: 0.8 }],
        },
        {
          topicId: "topic_002",
          matchingScenes: [{ sceneId: "clip02_scene002", score: 0.3 }],
        },
      ],
      version: "1.0",
    });
    writeJson(path.join(workDir, ARTIFACTS.clipRegistry), {
      clipRegistry: [
        { clipId: "clip01", clipRole: "aroll_primary" },
        { clipId: "clip02", clipRole: "broll_pool" },
      ],
    });

    const report = buildBatchQualityReport(workDir);
    assert.equal(report.batchId, "batch01");
    assert.equal(report.metrics.anchorCoveragePercent, 50);
    assert.equal(report.metrics.faceAnchorPercent, 50);
    assert.equal(report.metrics.speechWordCount, 1);
    assert.equal(report.metrics.fillerRatio, 0.5);
    assert.equal(report.metrics.topicCount, 2);
    assert.equal(report.metrics.topicMatchRate, 50);
    assert.equal(report.metrics.topicsWithMatch, 1);
    assert.equal(report.metrics.avgBestMatchScore, 0.55);
    assert.equal(report.metrics.brollPoolSize, 1);
    assert.equal(report.metrics.l1FieldsPresentPercent, 100);
    assert.equal(report.metrics.needsHumanReview, false);
    assert.deepEqual(report.metrics.qualityGateFailures, []);
  });

  it("uses brollMatchThreshold from recipe batchContext", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch-threshold",
      scenes: [],
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch-threshold",
      scenes: [],
    });
    writeJson(path.join(workDir, ARTIFACTS.manifest), {
      batchId: "batch-threshold",
      batchContext: { brollMatchThreshold: 0.4 },
    });
    writeJson(path.join(workDir, ARTIFACTS.topicIndex), {
      topics: [
        {
          topicId: "topic_001",
          matchingScenes: [{ sceneId: "clip02_scene001", score: 0.5 }],
        },
        {
          topicId: "topic_002",
          matchingScenes: [{ sceneId: "clip02_scene002", score: 0.3 }],
        },
      ],
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeDraft), {
      version: "2.0",
      batchId: "batch-threshold",
      batchContext: { brollMatchThreshold: 0.6, requiredFormats: ["16:9"] },
    });

    const report = buildBatchQualityReport(workDir);
    assert.equal(report.metrics.topicMatchThreshold, 0.6);
    assert.equal(report.metrics.topicMatchRate, 0);
    assert.equal(report.metrics.topicsWithMatch, 0);
  });

  it("falls back to manifest brollMatchThreshold when recipe has none", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch-manifest-threshold",
      scenes: [],
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch-manifest-threshold",
      scenes: [],
    });
    writeJson(path.join(workDir, ARTIFACTS.manifest), {
      batchId: "batch-manifest-threshold",
      batchContext: { brollMatchThreshold: 0.4 },
    });
    writeJson(path.join(workDir, ARTIFACTS.topicIndex), {
      topics: [
        {
          topicId: "topic_001",
          matchingScenes: [{ sceneId: "clip02_scene001", score: 0.5 }],
        },
      ],
    });

    const report = buildBatchQualityReport(workDir);
    assert.equal(report.metrics.topicMatchThreshold, 0.4);
    assert.equal(report.metrics.topicMatchRate, 100);
    assert.equal(report.metrics.topicsWithMatch, 1);
  });

  it("flags needsHumanReview and qualityGateFailures when gates fail", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch-gates",
      scenes: [
        { sceneId: "clip01_scene001" },
        { sceneId: "clip01_scene002" },
      ],
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch-gates",
      scenes: [
        { sceneId: "clip01_scene001", anchors: [] },
        { sceneId: "clip01_scene002", anchors: [] },
      ],
    });
    writeJson(path.join(workDir, ARTIFACTS.abstraction), {
      L1: [{ sceneId: "clip01_scene001", brollPotential: 0.2 }],
    });
    writeJson(path.join(workDir, ARTIFACTS.topicIndex), {
      topics: [
        {
          topicId: "topic_001",
          matchingScenes: [{ sceneId: "clip02_scene001", score: 0.2 }],
        },
        {
          topicId: "topic_002",
          matchingScenes: [{ sceneId: "clip02_scene002", score: 0.1 }],
        },
      ],
    });

    const report = buildBatchQualityReport(workDir);
    assert.equal(report.metrics.needsHumanReview, true);
    assert.deepEqual(report.metrics.qualityGateFailures, [
      "anchor_coverage_below_50",
      "topic_match_rate_below_50",
      "l1_fields_present_below_80",
    ]);
  });

  it("includes recipe creative metrics and validation counts", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch02",
      scenes: [{ sceneId: "clip01_scene001" }],
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch02",
      scenes: [{ sceneId: "clip01_scene001", anchors: [] }],
    });
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      batchId: "batch02",
      clips: [{ clipId: "clip01" }],
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeDraft), {
      version: "2.0",
      batchId: "batch02",
      batchContext: { requiredFormats: ["16:9"] },
      clipRegistry: [
        {
          clipId: "clip01",
          fileName: "a.mp4",
          durationSec: 60,
          sortIndex: 0,
          clipRole: "aroll_primary",
          hasSpeech: true,
          speechWordCount: 0,
        },
      ],
      outputs: [
        {
          outputId: "main",
          format: "16:9",
          outputKind: "main",
          timeline: [
            {
              segmentId: "seg1",
              segmentRole: "aroll",
              videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
              audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
              videoInSec: 0,
              videoOutSec: 10,
              audioInSec: 0,
              audioOutSec: 10,
              audioPolicy: "from_video_ref",
            },
          ],
        },
      ],
      creativeMoments: [
        { momentId: "m1", outputId: "main", techniqueId: "retention_beat", retentionRole: "beat", anchorSec: 5 },
        { momentId: "m2", outputId: "main", techniqueId: "hook_title_overlay", retentionRole: "hook", anchorSec: 1 },
      ],
      excluded: [],
    });

    const report = buildBatchQualityReport(workDir);
    assert.equal(report.metrics.creativeMomentCount, 2);
    assert.equal(report.metrics.retentionBeatCount, 1);
    assert.ok(typeof report.metrics.validationErrorCount === "number");
  });

  it("formatBatchQualitySummary renders human-readable lines", () => {
    const summary = formatBatchQualitySummary({
      batchId: "x",
      metrics: {
        anchorCoveragePercent: 80,
        faceAnchorPercent: 40,
        sceneCount: 5,
        scenesWithAnchors: 4,
        scenesWithFace: 2,
        speechWordCount: 100,
        fillerRatio: 0.1,
        topicCount: 3,
        brollPoolSize: 2,
        l1FieldsPresentPercent: 90,
        creativeMomentCount: 0,
        retentionBeatCount: 0,
        validationErrorCount: 0,
        validationWarningCount: 0,
        dataQualityWarnings: ["vision_captions_stub", "audio_analysis_stub"],
        qualityGateFailures: [],
        needsHumanReview: false,
      },
    });
    assert.match(summary, /Anchor coverage: 80%/);
    assert.match(summary, /Data quality warnings: vision_captions_stub, audio_analysis_stub/);
    assert.match(summary, /Needs human review: no/);
  });

  it("detects stub vision captions and audio analysis in report", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch_stub",
      scenes: [],
      visionCaptions: [
        { timestampSec: 1, sceneId: "clip01_scene001", caption: "[stub] Klatka test" },
      ],
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      batchId: "batch_stub",
      clips: [{ clipId: "clip01", sourcePath: "/a.mp4", durationSec: 10 }],
      scenes: [],
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch_stub",
      scenes: [],
    });
    writeJson(path.join(workDir, ARTIFACTS.audioAnalysis("clip01")), {
      clipId: "clip01",
      analysisMode: "stub",
      eventDetectionMode: "stub",
    });

    const report = buildBatchQualityReport(workDir);
    assert.deepEqual(report.metrics.dataQualityWarnings, [
      "vision_captions_stub",
      "audio_analysis_stub",
    ]);
  });

  it("warns when topic index uses keyword-only matching (v1.0)", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch_kw",
      scenes: [],
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch_kw",
      scenes: [],
    });
    writeJson(path.join(workDir, ARTIFACTS.topicIndex), {
      version: "1.0",
      batchId: "batch_kw",
      topics: [{ topicId: "t1", label: "jedzenie", matchingScenes: [] }],
    });

    const report = buildBatchQualityReport(workDir);
    assert.ok(report.metrics.dataQualityWarnings.includes("topic_index_keyword_only"));
  });

  it("writeBatchQualityReport persists JSON artifact", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch03",
      scenes: [],
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch03",
      scenes: [],
    });

    const { outPath, report } = writeBatchQualityReport(workDir, { qualityProfile: "production" });
    assert.ok(fs.existsSync(outPath));
    assert.equal(report.batchId, "batch03");
    assert.equal(report.qualityProfile, "production");
    assert.equal(path.basename(outPath), ARTIFACTS.batchQualityReport);
  });

  it("computes stub coverage and provenance metrics when artifacts exist", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch_prov",
      scenes: [],
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch_prov",
      scenes: [{ sceneId: "clip01_scene001", anchors: [{ type: "face" }] }],
    });
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      batchId: "batch_prov",
      clips: [{ clipId: "clip01" }, { clipId: "clip02" }],
    });
    writeJson(path.join(workDir, ARTIFACTS.vision("clip01")), {
      clipId: "clip01",
      captions: [{ caption: "[stub] test" }],
    });
    writeJson(path.join(workDir, ARTIFACTS.audioAnalysis("clip02")), {
      clipId: "clip02",
      analysisMode: "stub",
    });
    writeJson(path.join(workDir, ARTIFACTS.review), {
      version: "1.0",
      batchId: "batch_prov",
      iteration: 2,
      approved: true,
      issues: [],
      summary: "ok",
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeProvenance), buildProvenanceDocument({
      batchId: "batch_prov",
      enricherLog: [{
        enricher: "pacing-enrich",
        delta: { segmentsAdded: 1, creativeMomentsAdded: 2, cutsAdded: 0, segmentsRemoved: 0, sfxPlanAdded: 0 },
      }],
      stitchValidation: {
        valid: false,
        issues: [{ severity: "warning", code: "STITCH-01", message: "gap" }],
      },
      reviewIterations: 2,
    }));

    const report = buildBatchQualityReport(workDir);
    assert.equal(report.metrics.stubCoverage.vision, 50);
    assert.equal(report.metrics.stubCoverage.audio, 50);
    assert.equal(report.metrics.reviewIterations, 2);
    assert.equal(report.metrics.enricherContribution.totals.creativeMomentsAdded, 2);
    assert.equal(report.metrics.stitchIssues.length, 1);
  });

  it("handles missing recipe provenance gracefully", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch_no_prov",
      scenes: [],
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch_no_prov",
      scenes: [],
    });

    const report = buildBatchQualityReport(workDir);
    assert.equal(report.metrics.enricherContribution, null);
    assert.equal(report.metrics.stitchIssues, null);
  });

  it("production profile flags stub coverage and missing review", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch_prod",
      scenes: [{ sceneId: "clip01_scene001" }],
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch_prod",
      scenes: [{ sceneId: "clip01_scene001", anchors: [{ type: "face" }] }],
    });
    writeJson(path.join(workDir, ARTIFACTS.abstraction), {
      L1: [{ sceneId: "clip01_scene001", brollPotential: 0.2 }],
    });
    writeJson(path.join(workDir, ARTIFACTS.topicIndex), {
      topics: [{ topicId: "t1", matchingScenes: [{ sceneId: "clip02_scene001", score: 0.9 }] }],
    });
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      batchId: "batch_prod",
      clips: [{ clipId: "clip01" }],
    });
    writeJson(path.join(workDir, ARTIFACTS.vision("clip01")), {
      clipId: "clip01",
      captions: [{ caption: "[stub] test" }],
    });

    const report = buildBatchQualityReport(workDir, { qualityProfile: "production" });
    assert.ok(report.metrics.qualityGateFailures.includes("stub_coverage_nonzero"));
    assert.ok(report.metrics.qualityGateFailures.includes("review_not_approved"));
  });

  it("reads provenance director and super-critic metrics", () => {
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
      batchId: "batch_prov_metrics",
      scenes: Array.from({ length: 35 }, (_, i) => ({ sceneId: `clip01_scene${String(i + 1).padStart(3, "0")}` })),
      stats: { totalWords: 0, fillerWordCount: 0 },
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "batch_prov_metrics",
      scenes: [{ sceneId: "clip01_scene001", anchors: [{ type: "face" }] }],
    });
    writeJson(path.join(workDir, ARTIFACTS.abstraction), {
      L1: [{ sceneId: "clip01_scene001", brollPotential: 0.2 }],
      L2: [{ segmentId: "seg1" }],
    });
    writeJson(path.join(workDir, ARTIFACTS.topicIndex), {
      topics: [{ topicId: "t1", matchingScenes: [{ sceneId: "clip02_scene001", score: 0.9 }] }],
    });
    writeJson(path.join(workDir, ARTIFACTS.review), {
      version: "1.0",
      batchId: "batch_prov_metrics",
      iteration: 1,
      approved: true,
      issues: [],
      summary: "ok",
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeProvenance), buildProvenanceDocument({
      batchId: "batch_prov_metrics",
      directorMetrics: { briefSceneMapCoverage: 0.4 },
      superCriticReview: { approved: false, issues: [], summary: "arc gap" },
    }));

    const report = buildBatchQualityReport(workDir, { qualityProfile: "production" });
    assert.equal(report.metrics.briefSceneMapCoverage, 0.4);
    assert.equal(report.metrics.superPath, false);
    assert.equal(report.metrics.superCriticApproved, false);
    assert.ok(report.metrics.qualityGateFailures.includes("brief_scene_map_coverage_low"));
    assert.ok(!report.metrics.qualityGateFailures.includes("super_critic_not_approved"));
  });
});
