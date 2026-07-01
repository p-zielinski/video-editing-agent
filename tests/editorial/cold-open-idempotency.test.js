import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildColdOpenSegmentHint,
  enrichRecipeColdOpenSegment,
  enrichRecipeChapterCards,
  COLD_OPEN_SEGMENT_ID,
} from "../../src/editorial/chapter-hints.js";

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 90, durationSec: 90 },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 90, endSec: 180, durationSec: 90 },
    { sceneId: "clip02_scene002", clipId: "clip02", startSec: 80, endSec: 95, durationSec: 15 },
  ],
};

const abstraction = {
  L2: [
    {
      segmentId: "seg001",
      startSec: 0,
      endSec: 300,
      sceneIds: ["clip01_scene001"],
      summary: "Intro o restauracji.",
    },
    {
      segmentId: "seg002",
      startSec: 300,
      endSec: 600,
      sceneIds: ["clip01_scene002"],
      summary: "Payoff — restauracja była super.",
    },
  ],
  L3: {
    sessionSummary: "Vlog o restauracji.",
    narrativeArc: "intro → restauracja → podsumowanie",
  },
};

const clipRegistry = [
  { clipId: "clip01", sortIndex: 0, clipRole: "aroll_primary", hasSpeech: true },
  { clipId: "clip02", sortIndex: 1, clipRole: "broll_pool", hasSpeech: false },
];

function longMainRecipe() {
  return {
    batchContext: { inputMode: "multi_clip_day", brollStrategy: "match_speech_topics" },
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      targetDurationSec: 720,
      timeline: [{
        segmentId: "seg_body",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 360,
        audioInSec: 0,
        audioOutSec: 360,
        audioPolicy: "from_video_ref",
        textOverlays: [],
      }],
    }],
    creativeMoments: [],
    sfxPlan: [],
  };
}

function runColdOpenAndChapterEnrich(recipe) {
  const hint = buildColdOpenSegmentHint(
    abstraction,
    { outputs: recipe.outputs, batchContext: recipe.batchContext ?? {} },
    { clipRegistry, timelineIndex },
  );
  enrichRecipeColdOpenSegment(recipe, hint, timelineIndex);
  enrichRecipeChapterCards(recipe, { abstraction });
}

describe("cold-open idempotency", () => {
  it("second enrich pass does not duplicate cold open or chapter cards", () => {
    const recipe = longMainRecipe();

    runColdOpenAndChapterEnrich(recipe);
    const timelineLenAfterFirst = recipe.outputs[0].timeline.length;
    const chapterCountAfterFirst = recipe.outputs[0].timeline
      .flatMap((seg) => seg.textOverlays ?? [])
      .filter((o) => o.style === "chapter_card").length;

    runColdOpenAndChapterEnrich(recipe);

    const timeline = recipe.outputs[0].timeline;
    assert.equal(timeline.length, timelineLenAfterFirst);
    assert.equal(timeline[0].segmentId, COLD_OPEN_SEGMENT_ID);

    const chapterCards = timeline.flatMap((seg) => seg.textOverlays ?? [])
      .filter((o) => o.style === "chapter_card");
    assert.equal(chapterCards.length, chapterCountAfterFirst);
    assert.ok(chapterCards.every((o) => o.overlayId?.startsWith("enrich_chapter_")));
  });
});
