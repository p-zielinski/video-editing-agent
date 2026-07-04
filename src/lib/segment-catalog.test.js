import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSegmentCatalog,
  rankSegmentsByUserContext,
  shouldUseSuperDirector,
  resolveSegmentPicks,
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
});
