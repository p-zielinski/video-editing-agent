import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCreativeFidelity,
  buildOutputFidelityEntry,
  buildSegmentFidelity,
  classifySegmentAudioSource,
  collectFidelityCliWarnings,
  DURATION_DRIFT_WARN_SEC,
  mergeFidelityOutput,
  recordOutputFidelity,
  resolveEnhancementMeta,
} from "./montage-fidelity.js";
import { ARTIFACTS } from "../pipeline/work-paths.js";

describe("montage-fidelity", () => {
  it("classifySegmentAudioSource detects enhanced vs original", () => {
    const context = {
      enhancedAudioPaths: {
        clip_a: "/tmp/enhanced/clip_a.wav",
      },
    };
    assert.equal(
      classifySegmentAudioSource({
        audioSourcePath: "/tmp/enhanced/clip_a.wav",
        videoRef: { clipId: "clip_a" },
      }, context),
      "enhanced",
    );
    assert.equal(
      classifySegmentAudioSource({
        audioSourcePath: "/tmp/original/clip_a.mov",
        videoRef: { clipId: "clip_a" },
      }, context),
      "original",
    );
    assert.equal(
      classifySegmentAudioSource({ audioSourcePath: null }, context),
      null,
    );
  });

  it("resolveEnhancementMeta maps accept/reject/none and index status", () => {
    assert.deepEqual(
      resolveEnhancementMeta("clip_a", {
        audioEnhancementDecisions: [{ clipId: "clip_a", action: "accept" }],
      }, {
        clips: [{ clipId: "clip_a", status: "succeeded" }],
      }),
      { enhancementDecision: "accept", enhancementIndexStatus: "succeeded" },
    );
    assert.deepEqual(
      resolveEnhancementMeta("clip_b", {
        audioEnhancementDecisions: [{ clipId: "clip_b", action: "reject" }],
      }, { clips: [] }),
      { enhancementDecision: "reject", enhancementIndexStatus: "missing" },
    );
    assert.deepEqual(
      resolveEnhancementMeta("clip_c", {}, null),
      { enhancementDecision: "none", enhancementIndexStatus: "missing" },
    );
  });

  it("buildSegmentFidelity records preserveAmbient + audio source", () => {
    const fidelity = buildSegmentFidelity(
      {
        segmentId: "seg1",
        videoRef: { clipId: "clip_a" },
        audioSourcePath: "/work/original.mov",
        preserveAmbientAudio: true,
      },
      { enhancedAudioPaths: { clip_a: "/work/enhanced.wav" } },
      {
        audioEnhancementDecisions: [
          { clipId: "clip_a", action: "reject", reason: "intentional_ambient_preserve" },
        ],
      },
      { clips: [{ clipId: "clip_a", status: "succeeded" }] },
    );
    assert.equal(fidelity.audioSource, "original");
    assert.equal(fidelity.preserveAmbientAudio, true);
    assert.equal(fidelity.enhancementDecision, "reject");
    assert.equal(fidelity.enhancementIndexStatus, "succeeded");
  });

  it("buildCreativeFidelity captures planned/applied/fallbacks/disabled", () => {
    const moments = [
      { momentId: "m1", techniqueId: "hook_visual_punch" },
      {
        momentId: "m2",
        techniqueId: "silence_beat",
        disabled: true,
        reason: "silence_beat [soft-disabled: intentional_ambient_preserve]",
      },
      { momentId: "m3", techniqueId: "ken_burns" },
    ];
    const withFallback = buildCreativeFidelity(moments, [
      {
        code: "CREATIVE_FALLBACK",
        momentId: "m3",
        techniqueId: "ken_burns",
        message: "ffmpeg failed",
      },
    ], { appliedTechniqueIds: ["hook_visual_punch"] });

    assert.deepEqual(
      withFallback.planned.sort(),
      ["hook_visual_punch", "ken_burns", "silence_beat"].sort(),
    );
    // Whole creative pass fallback clears applied video techniques.
    assert.deepEqual(withFallback.applied, []);
    assert.equal(withFallback.fallbacks.length, 1);
    assert.equal(withFallback.fallbacks[0].momentId, "m3");
    assert.equal(withFallback.disabled.length, 1);
    assert.equal(withFallback.disabled[0].techniqueId, "silence_beat");

    const appliedOnly = buildCreativeFidelity(
      moments.filter((m) => !m.disabled),
      [],
      { appliedTechniqueIds: ["hook_visual_punch"] },
    );
    assert.deepEqual(appliedOnly.applied, ["hook_visual_punch"]);
    assert.equal(appliedOnly.fallbacks.length, 0);
  });

  it("buildOutputFidelityEntry computes duration drift and mix fields", () => {
    const entry = buildOutputFidelityEntry({
      output: {
        outputId: "main_16x9",
        format: "16:9",
        timeline: [
          { segmentId: "s1", outputStartSec: 0, outputEndSec: 10, videoRef: { clipId: "c1" } },
        ],
      },
      recipe: {
        audioEnhancementDecisions: [{ clipId: "c1", action: "accept" }],
        creativeMoments: [
          { momentId: "m1", outputId: "main_16x9", techniqueId: "hook_visual_punch" },
        ],
      },
      edl: {
        durationSec: 10,
        segments: [
          {
            segmentId: "s1",
            videoRef: { clipId: "c1" },
            audioSourcePath: "/e/c1.wav",
          },
        ],
        creativeMoments: [
          { momentId: "m1", techniqueId: "hook_visual_punch" },
        ],
      },
      context: { enhancedAudioPaths: { c1: "/e/c1.wav" } },
      probedDurationSec: 9.2,
      warnings: [],
      creativeResult: { appliedTechniqueIds: ["hook_visual_punch"] },
      mixResult: {
        applied: true,
        duckingWindowCount: 4,
        duckingSource: "speech_derived",
        appliedAudioTechniques: ["silence_beat"],
        warnings: [{ code: "SFX_MISSING", message: "missing sfx" }],
      },
      enhancementIndex: { clips: [{ clipId: "c1", status: "succeeded" }] },
    });

    assert.equal(entry.recipeDurationSec, 10);
    assert.equal(entry.edlDurationSec, 10);
    assert.equal(entry.probedDurationSec, 9.2);
    assert.ok(Math.abs(entry.durationDriftSec - (-0.8)) < 1e-9);
    assert.equal(entry.segments[0].audioSource, "enhanced");
    assert.equal(entry.audioMix.duckingWindowCount, 4);
    assert.equal(entry.audioMix.duckingSource, "speech_derived");
    assert.deepEqual(entry.creative.applied, ["hook_visual_punch"]);
  });

  it("collectFidelityCliWarnings flags drift > 1s and CREATIVE_FALLBACK", () => {
    const warnings = collectFidelityCliWarnings({
      outputs: [
        {
          outputId: "main_16x9",
          durationDriftSec: -(DURATION_DRIFT_WARN_SEC + 0.5),
          creative: {
            fallbacks: [{
              code: "CREATIVE_FALLBACK",
              momentId: "m1",
              techniqueId: "zoom_punch",
              message: "fail",
            }],
          },
        },
        {
          outputId: "short_9x16",
          durationDriftSec: 0.2,
          creative: { fallbacks: [] },
        },
      ],
    });
    assert.ok(warnings.some((w) => w.code === "DURATION_DRIFT"));
    assert.ok(warnings.some((w) => w.code === "CREATIVE_FALLBACK"));
    assert.equal(warnings.filter((w) => w.outputId === "short_9x16").length, 0);
  });

  it("recordOutputFidelity merges across outputs on disk", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fidelity-"));
    try {
      const recipe = { batchId: "batch01", creativeMoments: [] };
      const outputA = {
        outputId: "main_16x9",
        format: "16:9",
        timeline: [{ segmentId: "s1", outputStartSec: 0, outputEndSec: 5 }],
      };
      const outputB = {
        outputId: "short_9x16",
        format: "9:16",
        timeline: [{ segmentId: "s1", outputStartSec: 0, outputEndSec: 3 }],
      };

      recordOutputFidelity(workDir, {
        batchId: "batch01",
        output: outputA,
        recipe,
        edl: { durationSec: 5, segments: [] },
        context: {},
        result: { durationSec: 5, warnings: [], outputPath: "/a.mp4" },
      });
      const { artifact } = recordOutputFidelity(workDir, {
        batchId: "batch01",
        output: outputB,
        recipe,
        edl: { durationSec: 3, segments: [] },
        context: {},
        result: { durationSec: 3, warnings: [], outputPath: "/b.mp4" },
      });

      assert.equal(artifact.outputs.length, 2);
      const written = JSON.parse(
        fs.readFileSync(path.join(workDir, ARTIFACTS.montageFidelity), "utf8"),
      );
      assert.equal(written.version, "1.0");
      assert.equal(written.outputs.length, 2);

      // Upsert same outputId
      const merged = mergeFidelityOutput(written, {
        ...written.outputs[0],
        durationDriftSec: -2,
      });
      assert.equal(merged.outputs.length, 2);
      assert.equal(
        merged.outputs.find((o) => o.outputId === "main_16x9").durationDriftSec,
        -2,
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
