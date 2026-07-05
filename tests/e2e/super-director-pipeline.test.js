import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyDeterministicRecipeEnrichers,
  runSuperDirectorDirectPath,
} from "../../src/pipeline/steps/agents.js";
import { loadFixture } from "../../src/agents/test-helpers.js";
import {
  createMockOpenAIClient,
  buildMiniDaySuperDirectorPlan,
  buildMiniDaySegmentPartial,
} from "../../src/test-helpers/mock-openai-client.js";
import { validateStitchContinuity } from "../../src/validators/stitch-continuity.js";
import { validateNarrative } from "../../src/validators/narrative.js";

describe("super-director pipeline e2e (mocked)", () => {
  it("merges multi-L2 partials, enriches, and passes stitch + narrative validators", async () => {
    const abstraction = loadFixture("abstraction.json");
    const multiL2 = {
      ...abstraction,
      L2: [
        abstraction.L2[0],
        {
          ...abstraction.L2[0],
          segmentId: "seg002",
          summary: "Druga część vloga",
          sceneIds: ["clip01_scene002"],
          startSec: 60,
          endSec: 120,
        },
      ],
    };
    const timelineIndex = loadFixture("timeline-index.json");
    const clipRegistry = [{ clipId: "clip01", sortIndex: 0, durationSec: 120 }];
    const wordIndexes = [];

    const superPlan = buildMiniDaySuperDirectorPlan();
    const partials = [
      { ...buildMiniDaySegmentPartial("seg001"), segmentId: "seg001" },
      { ...buildMiniDaySegmentPartial("seg002"), segmentId: "seg002" },
    ];

    const client = createMockOpenAIClient([
      superPlan,
      buildMiniDaySegmentPartial("seg001"),
      buildMiniDaySegmentPartial("seg002"),
      { approved: true, issues: [], summary: "ok", crossSegmentNotes: [] },
    ]);

    const recipe = await runSuperDirectorDirectPath(client, {
      abstraction: multiL2,
      timelineIndex,
      clipRegistry,
      userContext: "",
      requiredFormats: ["16:9", "9:16"],
      batchContext: { brollStrategy: "minimal" },
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes,
      keyframesByClip: [],
    });

    assert.ok(recipe.stitchValidation?.valid);
    assert.ok(recipe.outputs[0].timeline.length > 0);
    assert.ok(
      recipe.retentionBeatTargets?.length >= 1,
      "super-director merge should attach retentionBeatTargets",
    );

    applyDeterministicRecipeEnrichers(recipe, {
      abstraction: multiL2,
      timelineIndex,
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      clipRegistry,
      perClipAnalysis: null,
      batchContext: { brollStrategy: "minimal" },
      wordIndexes,
    });

    const stitchIssues = validateStitchContinuity(recipe, {
      superPlan,
      abstraction: multiL2,
      partials,
      wordIndexes,
    });
    assert.equal(stitchIssues.filter((issue) => issue.severity === "error").length, 0);

    const narrativeIssues = validateNarrative(recipe, {
      abstraction: multiL2,
      timelineIndex,
      wordIndexes,
    });
    assert.equal(narrativeIssues.filter((issue) => issue.severity === "error").length, 0);
  });
});
