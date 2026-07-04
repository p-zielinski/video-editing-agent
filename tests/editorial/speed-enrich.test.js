import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRecipeFastRhythmSpeed,
  MAX_FAST_RHYTHM_SPEED_SEGMENTS,
} from "../../src/editorial/speed-enrich.js";
import { applyDeterministicRecipeEnrichers } from "../../src/pipeline/steps/agents.js";

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
    { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 60 },
  ],
};

const abstraction = {
  L2: [
    {
      segmentId: "seg_tension",
      sceneIds: ["clip01_scene001"],
      startSec: 0,
      endSec: 120,
      narrativeRole: "tension",
    },
    {
      segmentId: "seg_breath",
      sceneIds: ["clip01_scene001"],
      startSec: 120,
      endSec: 240,
      narrativeRole: "breath",
    },
  ],
};

function buildBrollSegment({
  segmentId,
  videoClipId = "clip02",
  audioClipId = "clip01",
  videoInSec = 0,
  videoOutSec = 10,
  audioInSec = 0,
  audioOutSec = 10,
  videoTransform,
} = {}) {
  return {
    segmentId,
    segmentRole: "broll",
    videoRef: { clipId: videoClipId, sceneId: `${videoClipId}_scene001` },
    audioRef: { clipId: audioClipId, sceneId: `${audioClipId}_scene001` },
    videoInSec,
    videoOutSec,
    audioInSec,
    audioOutSec,
    audioPolicy: "from_audio_ref",
    ...(videoTransform ? { videoTransform } : {}),
  };
}

function buildMainRecipe(timeline, extra = {}) {
  return {
    version: "2.4",
    batchId: "batch1",
    batchContext: { requiredFormats: ["16:9"], brollStrategy: "minimal" },
    clipRegistry: [
      { clipId: "clip01", clipRole: "aroll_primary", hasSpeech: true, durationSec: 240 },
      { clipId: "clip02", clipRole: "broll_pool", hasSpeech: false, durationSec: 60 },
    ],
    narrativeProfile: {
      segments: [
        { l2SegmentId: "seg_tension", rhythm: "fast", retentionIntensity: "high" },
        {
          l2SegmentId: "seg_breath",
          rhythm: "slow",
          retentionIntensity: "low",
          silencePolicy: "preserve",
        },
      ],
    },
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      timeline,
    }],
    creativeMoments: [],
    ...extra,
  };
}

describe("enrichRecipeFastRhythmSpeed", () => {
  it("speeds silent broll in fast/tension L2 with video_only mode", () => {
    const recipe = buildMainRecipe([
      buildBrollSegment({ segmentId: "broll_1", videoInSec: 0, videoOutSec: 8 }),
    ]);

    enrichRecipeFastRhythmSpeed(recipe, { abstraction, timelineIndex });

    const segment = recipe.outputs[0].timeline[0];
    assert.equal(segment.videoTransform.speed, 2.0);
    assert.equal(segment.videoTransform.speedMode, "video_only");
  });

  it("uses 1.5 speed when retentionIntensity is medium", () => {
    const recipe = buildMainRecipe([
      buildBrollSegment({ segmentId: "broll_1" }),
    ], {
      narrativeProfile: {
        segments: [{ l2SegmentId: "seg_tension", rhythm: "fast", retentionIntensity: "medium" }],
      },
    });

    enrichRecipeFastRhythmSpeed(recipe, { abstraction, timelineIndex });

    assert.equal(recipe.outputs[0].timeline[0].videoTransform.speed, 1.5);
  });

  it("skips aroll segments even in tension L2", () => {
    const recipe = buildMainRecipe([{
      segmentId: "aroll_1",
      segmentRole: "aroll",
      videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 30,
      audioInSec: 0,
      audioOutSec: 30,
      audioPolicy: "from_video_ref",
    }]);

    enrichRecipeFastRhythmSpeed(recipe, { abstraction, timelineIndex });

    assert.equal(recipe.outputs[0].timeline[0].videoTransform, undefined);
  });

  it("skips broll in breath/preserve L2 range", () => {
    const breathAbstraction = {
      L2: [{
        segmentId: "seg_breath",
        sceneIds: ["clip01_scene001"],
        startSec: 0,
        endSec: 120,
        narrativeRole: "breath",
      }],
    };
    const recipe = buildMainRecipe([
      buildBrollSegment({ segmentId: "broll_1" }),
    ], {
      narrativeProfile: {
        segments: [{
          l2SegmentId: "seg_breath",
          rhythm: "slow",
          retentionIntensity: "low",
          silencePolicy: "preserve",
        }],
      },
    });

    enrichRecipeFastRhythmSpeed(recipe, { abstraction: breathAbstraction, timelineIndex });

    assert.equal(recipe.outputs[0].timeline[0].videoTransform, undefined);
  });

  it("skips when videoTransform.speed is already set", () => {
    const recipe = buildMainRecipe([
      buildBrollSegment({
        segmentId: "broll_1",
        videoTransform: { speed: 1.8, speedMode: "video_only" },
      }),
    ]);

    enrichRecipeFastRhythmSpeed(recipe, { abstraction, timelineIndex });

    assert.equal(recipe.outputs[0].timeline[0].videoTransform.speed, 1.8);
  });

  it("skips broll when video clip has speech words in range", () => {
    const recipe = buildMainRecipe([
      buildBrollSegment({ segmentId: "broll_1", videoInSec: 0, videoOutSec: 10 }),
    ]);
    const wordIndexes = [{
      clipId: "clip02",
      words: [{ wordId: "clip02_w001", word: "oops", start: 2, end: 4 }],
    }];

    enrichRecipeFastRhythmSpeed(recipe, { abstraction, timelineIndex, wordIndexes });

    assert.equal(recipe.outputs[0].timeline[0].videoTransform, undefined);
  });

  it("detects broll via broll_pool videoRef without segmentRole broll", () => {
    const recipe = buildMainRecipe([{
      segmentId: "pool_1",
      segmentRole: "aroll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 6,
      audioInSec: 0,
      audioOutSec: 6,
      audioPolicy: "from_audio_ref",
    }]);

    enrichRecipeFastRhythmSpeed(recipe, { abstraction, timelineIndex });

    assert.equal(recipe.outputs[0].timeline[0].videoTransform.speed, 2.0);
    assert.equal(recipe.outputs[0].timeline[0].videoTransform.speedMode, "video_only");
  });

  it(`modifies at most ${MAX_FAST_RHYTHM_SPEED_SEGMENTS} segments per output`, () => {
    const timeline = Array.from({ length: 5 }, (_, index) => buildBrollSegment({
      segmentId: `broll_${index}`,
      videoInSec: index * 5,
      videoOutSec: index * 5 + 4,
      audioInSec: index * 5,
      audioOutSec: index * 5 + 4,
    }));
    const recipe = buildMainRecipe(timeline);

    enrichRecipeFastRhythmSpeed(recipe, { abstraction, timelineIndex });

    const sped = recipe.outputs[0].timeline.filter((seg) => seg.videoTransform?.speed > 1);
    assert.equal(sped.length, MAX_FAST_RHYTHM_SPEED_SEGMENTS);
  });

  it("is idempotent on second call", () => {
    const recipe = buildMainRecipe([
      buildBrollSegment({ segmentId: "broll_1" }),
      buildBrollSegment({ segmentId: "broll_2", videoInSec: 10, videoOutSec: 18 }),
    ]);

    enrichRecipeFastRhythmSpeed(recipe, { abstraction, timelineIndex });
    const afterFirst = JSON.stringify(recipe.outputs[0].timeline);

    enrichRecipeFastRhythmSpeed(recipe, { abstraction, timelineIndex });
    assert.equal(JSON.stringify(recipe.outputs[0].timeline), afterFirst);
  });

  it("preserves existing videoTransform fields when adding speed", () => {
    const recipe = buildMainRecipe([
      buildBrollSegment({
        segmentId: "broll_1",
        videoTransform: { fitMode: "pillarbox" },
      }),
    ]);

    enrichRecipeFastRhythmSpeed(recipe, { abstraction, timelineIndex });

    const transform = recipe.outputs[0].timeline[0].videoTransform;
    assert.equal(transform.fitMode, "pillarbox");
    assert.equal(transform.speed, 2.0);
    assert.equal(transform.speedMode, "video_only");
  });
});

describe("applyDeterministicRecipeEnrichers speed enrich wiring", () => {
  it("runs speed enrich after dead air and before retention beats", () => {
    const recipe = buildMainRecipe([
      buildBrollSegment({ segmentId: "broll_1" }),
    ], {
      vlogRetentionProfile: { enabled: true, beatIntervalSec: 45 },
    });

    applyDeterministicRecipeEnrichers(recipe, {
      abstraction,
      timelineIndex,
      clipRegistry: recipe.clipRegistry,
      batchContext: recipe.batchContext,
    });

    assert.equal(recipe.outputs[0].timeline[0].videoTransform?.speed, 2.0);
  });
});
