import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSegmentCatalog,
  rankSegmentsByUserContext,
  shouldUseSuperDirector,
  resolveSegmentPicks,
  resolveCanonicalSegmentOrder,
  SUPER_DIRECTOR_MAX_SEGMENT_PICKS,
  SUPER_DIRECTOR_DURATION_THRESHOLD_SEC,
} from "./segment-catalog.js";
import { loadFixture } from "../agents/test-helpers.js";

describe("segment-catalog", () => {
  const abstraction = loadFixture("abstraction.json");
  const timelineIndex = loadFixture("timeline-index.json");
  const clipRegistry = [
    {
      clipId: "clip01",
      sortIndex: 0,
      durationSec: 120,
    },
  ];

  it("buildSegmentCatalog passes narrativeRole from L2 abstraction", () => {
    const withRoles = {
      L2: [{
        segmentId: "seg001",
        summary: "Kulminacja w restauracji",
        sceneIds: ["clip01_scene001", "clip01_scene002"],
        startSec: 0,
        endSec: 120,
        narrativeRole: "climax",
      }],
    };
    const catalog = buildSegmentCatalog(withRoles, timelineIndex, clipRegistry);
    assert.equal(catalog[0].narrativeRole, "climax");
  });

  it("buildSegmentCatalog produces L2 cards with scene and clip ids", () => {
    const catalog = buildSegmentCatalog(abstraction, timelineIndex, clipRegistry);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].segmentId, "seg001");
    assert.equal(catalog[0].sceneIds.length, 2);
    assert.deepEqual(catalog[0].clipIds, ["clip01"]);
    assert.equal(catalog[0].durationSec, 120);
    assert.match(catalog[0].summary, /intro/i);
    assert.equal(catalog[0].topSceneRanks.length, 2);
    assert.equal(catalog[0].speechSceneCount, 2);
    assert.equal(catalog[0].brollSceneCount, 0);
  });

  it("rankSegmentsByUserContext boosts keyword matches", () => {
    const multiL2 = {
      L2: [
        { segmentId: "seg001", summary: "Spacer po parku", sceneIds: ["s1"], startSec: 0, endSec: 60 },
        { segmentId: "seg002", summary: "Restauracja i jedzenie", sceneIds: ["s2"], startSec: 60, endSec: 120 },
      ],
    };
    const catalog = buildSegmentCatalog(multiL2, timelineIndex, clipRegistry);
    const ranked = rankSegmentsByUserContext("vlog restauracja", catalog);
    assert.equal(ranked[0].segmentId, "seg002");
  });

  it("shouldUseSuperDirector bypasses short single-segment batches", () => {
    assert.equal(shouldUseSuperDirector(timelineIndex, abstraction), false);
  });

  it("shouldUseSuperDirector activates when L2 has more than one segment", () => {
    const multiSegment = {
      ...abstraction,
      L2: [
        abstraction.L2[0],
        { ...abstraction.L2[0], segmentId: "seg002", summary: "Druga część" },
      ],
    };
    assert.equal(shouldUseSuperDirector(timelineIndex, multiSegment), true);
  });

  it("shouldUseSuperDirector activates when duration exceeds threshold", () => {
    const longTimeline = {
      ...timelineIndex,
      stats: { totalDurationSec: SUPER_DIRECTOR_DURATION_THRESHOLD_SEC + 1 },
    };
    assert.equal(shouldUseSuperDirector(longTimeline, abstraction), true);
  });

  it("resolveSegmentPicks respects segmentOrder and max picks", () => {
    const catalog = [
      { segmentId: "seg001", summary: "a" },
      { segmentId: "seg002", summary: "b" },
      { segmentId: "seg003", summary: "c" },
    ];
    const superPlan = {
      segmentOrder: ["seg003", "seg001", "seg002"],
      segmentPicks: [
        { segmentId: "seg001", priority: 2 },
        { segmentId: "seg002", priority: 3 },
        { segmentId: "seg003", priority: 1 },
      ],
    };
    const picks = resolveSegmentPicks(superPlan, catalog);
    assert.equal(picks.length, 3);
    assert.equal(picks[0].segmentId, "seg003");
    assert.ok(picks.length <= SUPER_DIRECTOR_MAX_SEGMENT_PICKS);
  });

  it("shouldUseSuperDirector respects batchContext duration threshold override", () => {
    const longTimeline = {
      ...timelineIndex,
      stats: { totalDurationSec: 700 },
    };
    assert.equal(
      shouldUseSuperDirector(longTimeline, abstraction, { superDirectorDurationThresholdSec: 800 }),
      false,
    );
    assert.equal(
      shouldUseSuperDirector(longTimeline, abstraction, { superDirectorDurationThresholdSec: 600 }),
      true,
    );
  });

  it("resolveSegmentPicks respects batchContext superDirectorMaxSegments", () => {
    const catalog = Array.from({ length: 5 }, (_, i) => ({
      segmentId: `seg00${i + 1}`,
      summary: `segment ${i + 1}`,
    }));
    const superPlan = {
      segmentOrder: catalog.map((card) => card.segmentId),
      segmentPicks: catalog.map((card, index) => ({
        segmentId: card.segmentId,
        priority: index + 1,
      })),
    };

    const picks = resolveSegmentPicks(superPlan, catalog, { superDirectorMaxSegments: 2 });
    assert.equal(picks.length, 2);
  });

  it("shouldUseSuperDirector is false when forceClassicDirector is set", () => {
    const longTimeline = {
      ...timelineIndex,
      stats: { totalDurationSec: SUPER_DIRECTOR_DURATION_THRESHOLD_SEC + 120 },
    };
    const multiSegment = {
      ...abstraction,
      L2: [
        abstraction.L2[0],
        { ...abstraction.L2[0], segmentId: "seg002", summary: "Druga część" },
      ],
    };

    assert.equal(
      shouldUseSuperDirector(longTimeline, multiSegment, { forceClassicDirector: true }),
      false,
    );
  });

  it("resolveCanonicalSegmentOrder respects segmentOrder then picks", () => {
    const superPlan = {
      segmentOrder: ["seg003", "seg001"],
      segmentPicks: [
        { segmentId: "seg001", priority: 2 },
        { segmentId: "seg002", priority: 1 },
        { segmentId: "seg003", priority: 3 },
      ],
    };
    const available = ["seg001", "seg002", "seg003"];
    const order = resolveCanonicalSegmentOrder(superPlan, available);
    assert.deepEqual(order, ["seg003", "seg001", "seg002"]);
  });

  it("resolveCanonicalSegmentOrder never restores unavailable segmentOrder ids", () => {
    const superPlan = {
      segmentOrder: ["seg_removed", "seg002", "seg001"],
      segmentPicks: [
        { segmentId: "seg_removed", priority: 1 },
        { segmentId: "seg001", priority: 2 },
        { segmentId: "seg002", priority: 3 },
      ],
    };

    const order = resolveCanonicalSegmentOrder(superPlan, ["seg001", "seg002"]);

    assert.deepEqual(order, ["seg002", "seg001"]);
    assert.equal(order.includes("seg_removed"), false);
  });
});
