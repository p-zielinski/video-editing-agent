import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildNarrativeProfileFromL2Roles,
  computeExemptDurationSec,
  effectiveGapSec,
  findL2SegmentIdForSourceTime,
  isSlowBreathNarrativeSegment,
  mergeOutputRanges,
  resolveL2SegmentProfile,
  resolveSegmentCaps,
  RHYTHM_CAPS,
  shouldPreserveSilenceForSegment,
  shouldSkipRetentionBeatEnrich,
} from "./narrative-profile.js";
import { NarrativeProfileSchema } from "../schemas/edit-recipe-v2.js";

const abstraction = {
  L2: [
    {
      segmentId: "seg001",
      startSec: 0,
      endSec: 120,
      sceneIds: ["clip01_scene001"],
    },
    {
      segmentId: "seg002",
      startSec: 120,
      endSec: 240,
      sceneIds: ["clip01_scene002"],
    },
  ],
};

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
  ],
};

describe("narrative-profile helpers", () => {
  it("findL2SegmentIdForSourceTime resolves via scene membership", () => {
    assert.equal(
      findL2SegmentIdForSourceTime(abstraction, timelineIndex, "clip01", 30),
      "seg001",
    );
    assert.equal(
      findL2SegmentIdForSourceTime(abstraction, timelineIndex, "clip01", 150),
      "seg002",
    );
  });

  it("shouldSkipRetentionBeatEnrich is true for slow or low intensity", () => {
    assert.equal(shouldSkipRetentionBeatEnrich({ rhythm: "slow" }), true);
    assert.equal(shouldSkipRetentionBeatEnrich({ retentionIntensity: "low" }), true);
    assert.equal(shouldSkipRetentionBeatEnrich({ rhythm: "fast", retentionIntensity: "high" }), false);
  });

  it("isSlowBreathNarrativeSegment includes breath narrativeRole", () => {
    assert.equal(
      isSlowBreathNarrativeSegment({ rhythm: "fast" }, { narrativeRole: "breath" }),
      true,
    );
    assert.equal(
      isSlowBreathNarrativeSegment({ rhythm: "fast", retentionIntensity: "high" }, { narrativeRole: "climax" }),
      false,
    );
  });

  it("effectiveGapSec subtracts exempt slow/breath spans", () => {
    const exempt = [{ startSec: 200, endSec: 500 }];
    assert.equal(effectiveGapSec(188, 505, exempt), 17);
    assert.equal(effectiveGapSec(188, 505, []), 317);
  });

  it("computeExemptDurationSec merges overlapping ranges", () => {
    const total = computeExemptDurationSec([
      { startSec: 0, endSec: 100 },
      { startSec: 80, endSec: 200 },
    ]);
    assert.equal(total, 200);
    assert.deepEqual(mergeOutputRanges([
      { startSec: 0, endSec: 100 },
      { startSec: 80, endSec: 200 },
    ]), [{ startSec: 0, endSec: 200 }]);
  });

  it("shouldPreserveSilenceForSegment respects global and per-segment policy", () => {
    const profile = {
      silencePolicy: "trim_dead_air",
      segments: [{ l2SegmentId: "seg002", silencePolicy: "preserve" }],
    };
    assert.equal(shouldPreserveSilenceForSegment(profile, "seg001"), false);
    assert.equal(shouldPreserveSilenceForSegment(profile, "seg002"), true);
    assert.equal(
      shouldPreserveSilenceForSegment({ silencePolicy: "preserve" }, "seg001"),
      true,
    );
  });

  it("resolveL2SegmentProfile returns matching segment controls", () => {
    const profile = {
      segments: [{ l2SegmentId: "seg001", rhythm: "slow" }],
    };
    assert.deepEqual(resolveL2SegmentProfile(profile, "seg001"), profile.segments[0]);
    assert.equal(resolveL2SegmentProfile(profile, "seg999"), null);
  });

  it("resolveSegmentCaps returns rhythm defaults and allows segment overrides", () => {
    assert.deepEqual(resolveSegmentCaps(null, "seg001", {
      L2: [{ segmentId: "seg001", narrativeRole: "breath" }],
    }), {
      rhythm: "slow",
      ...RHYTHM_CAPS.slow,
    });

    assert.deepEqual(resolveSegmentCaps({
      segments: [{ l2SegmentId: "seg002", rhythm: "fast" }],
    }, "seg002"), {
      rhythm: "fast",
      ...RHYTHM_CAPS.fast,
    });

    assert.deepEqual(resolveSegmentCaps({
      segments: [{
        l2SegmentId: "seg003",
        rhythm: "normal",
        maxEnrichBeats: 0,
        allowChapterCards: false,
      }],
    }, "seg003"), {
      rhythm: "normal",
      maxRetentionBeats: 1,
      maxEnrichBeats: 0,
      maxSfxEntries: 2,
      allowPatternInterrupt: false,
      allowChapterCards: false,
    });

    assert.equal(resolveSegmentCaps(null, "seg_unknown"), null);
  });
});

describe("buildNarrativeProfileFromL2Roles", () => {
  it("maps narrativeRole tags to rhythm, retentionIntensity, and silencePolicy", () => {
    const profile = buildNarrativeProfileFromL2Roles({
      L2: [
        { segmentId: "seg_breath", narrativeRole: "breath" },
        { segmentId: "seg_climax", narrativeRole: "climax" },
        { segmentId: "seg_payoff", narrativeRole: "payoff" },
        { segmentId: "seg_tension", narrativeRole: "tension" },
        { segmentId: "seg_resolution", narrativeRole: "resolution" },
      ],
    });

    assert.ok(profile);
    assert.equal(profile.segments.length, 5);

    const byId = Object.fromEntries(
      profile.segments.map((entry) => [entry.l2SegmentId, entry]),
    );

    assert.deepEqual(byId.seg_breath, {
      l2SegmentId: "seg_breath",
      rhythm: "slow",
      retentionIntensity: "low",
      silencePolicy: "preserve",
    });
    assert.deepEqual(byId.seg_climax, {
      l2SegmentId: "seg_climax",
      rhythm: "normal",
      retentionIntensity: "medium",
    });
    assert.deepEqual(byId.seg_payoff, {
      l2SegmentId: "seg_payoff",
      rhythm: "normal",
      retentionIntensity: "medium",
    });
    assert.deepEqual(byId.seg_tension, {
      l2SegmentId: "seg_tension",
      rhythm: "fast",
      retentionIntensity: "high",
    });
    assert.deepEqual(byId.seg_resolution, {
      l2SegmentId: "seg_resolution",
      rhythm: "slow",
      retentionIntensity: "low",
    });
  });

  it("maps setup and development narrativeRole to normal/medium rhythm", () => {
    const profile = buildNarrativeProfileFromL2Roles({
      L2: [
        { segmentId: "seg_setup", narrativeRole: "setup" },
        { segmentId: "seg_dev", narrativeRole: "development" },
        { segmentId: "seg_breath", narrativeRole: "breath" },
      ],
    });

    assert.equal(profile.segments.length, 3);
    assert.deepEqual(profile.segments[0], {
      l2SegmentId: "seg_setup",
      rhythm: "normal",
      retentionIntensity: "medium",
    });
    assert.deepEqual(profile.segments[1], {
      l2SegmentId: "seg_dev",
      rhythm: "normal",
      retentionIntensity: "medium",
    });
    assert.deepEqual(profile.segments[2], {
      l2SegmentId: "seg_breath",
      rhythm: "slow",
      retentionIntensity: "low",
      silencePolicy: "preserve",
    });
  });

  it("skips unmapped narrativeRole values and segments without narrativeRole", () => {
    const profile = buildNarrativeProfileFromL2Roles({
      L2: [
        { segmentId: "seg_none" },
        { segmentId: "seg_callback", narrativeRole: "callback" },
        { segmentId: "seg_breath", narrativeRole: "breath" },
      ],
    });

    assert.equal(profile.segments.length, 1);
    assert.equal(profile.segments[0].l2SegmentId, "seg_breath");
  });

  it("returns null when no mapped roles are present", () => {
    assert.equal(buildNarrativeProfileFromL2Roles(null), null);
    assert.equal(buildNarrativeProfileFromL2Roles({ L2: [] }), null);
    assert.equal(
      buildNarrativeProfileFromL2Roles({ L2: [{ segmentId: "seg001", narrativeRole: "callback" }] }),
      null,
    );
  });

  it("merges L2 role segments with existing profile and preserves top-level fields", () => {
    const profile = buildNarrativeProfileFromL2Roles(
      {
        L2: [
          { segmentId: "seg001", narrativeRole: "tension" },
          { segmentId: "seg002", narrativeRole: "breath" },
        ],
      },
      {
        mode: "internet_documentary",
        maxPatternInterruptsPer10Min: 2,
        segments: [{
          l2SegmentId: "seg001",
          rhythm: "slow",
          retentionIntensity: "low",
          silencePolicy: "preserve",
        }],
      },
    );

    assert.equal(profile.mode, "internet_documentary");
    assert.equal(profile.maxPatternInterruptsPer10Min, 2);
    assert.equal(profile.segments.length, 2);
    assert.deepEqual(profile.segments[0], {
      l2SegmentId: "seg001",
      rhythm: "slow",
      retentionIntensity: "low",
      silencePolicy: "preserve",
    });
    assert.deepEqual(profile.segments[1], {
      l2SegmentId: "seg002",
      rhythm: "slow",
      retentionIntensity: "low",
      silencePolicy: "preserve",
    });
  });

  it("returns existing profile unchanged when L2 has no mapped roles", () => {
    const existing = {
      mode: "retention_vlog",
      segments: [{ l2SegmentId: "seg001", rhythm: "slow" }],
    };
    assert.deepEqual(
      buildNarrativeProfileFromL2Roles({ L2: [{ segmentId: "seg001", narrativeRole: "callback" }] }, existing),
      existing,
    );
  });
});

describe("NarrativeProfileSchema", () => {
  it("parses valid narrativeProfile on recipe", () => {
    const parsed = NarrativeProfileSchema.parse({
      mode: "internet_documentary",
      segments: [{
        l2SegmentId: "seg001",
        rhythm: "slow",
        retentionIntensity: "low",
        silencePolicy: "preserve",
      }],
      maxPatternInterruptsPer10Min: 1,
      sfxNarrativeOnly: true,
    });
    assert.equal(parsed.mode, "internet_documentary");
    assert.equal(parsed.segments[0].rhythm, "slow");
  });

  it("rejects invalid rhythm values", () => {
    assert.throws(() => NarrativeProfileSchema.parse({
      segments: [{ l2SegmentId: "seg001", rhythm: "ultra" }],
    }));
  });
});
