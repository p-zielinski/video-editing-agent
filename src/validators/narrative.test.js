import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateNarrativePayoff,
  validateNarrativePayoffMissing,
  validateNarrativeBeatSpam,
  validateNarrativeBreathBeat,
  validateNarrativeClosureSpam,
  validateNarrativeCallbackUndelivered,
  validateNarrativeDramaticPauseCuts,
  validateNarrative,
} from "./narrative.js";

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
  ],
};

const abstraction = {
  L2: [
    { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
    { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240 },
  ],
  L3: {
    openLoops: [{
      loopId: "loop_01",
      kind: "cold_open",
      setupSceneId: "clip01_scene001",
      payoffSceneId: "clip01_scene002",
      teaseText: "Payoff tease",
    }],
  },
};

function buildMainRecipe(extra = {}) {
  return {
    version: "2.4",
    batchId: "batch1",
    batchContext: { requiredFormats: ["16:9"] },
    clipRegistry: [{ clipId: "clip01", durationSec: 240 }],
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      timeline: [{
        segmentId: "seg_body",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 240,
        audioInSec: 0,
        audioOutSec: 240,
        audioPolicy: "from_video_ref",
        cuts: [],
      }],
    }],
    creativeMoments: [],
    ...extra,
  };
}

describe("validateNarrativePayoff", () => {
  it("NAR-PAYOFF-UNDELIVERED when open loop lacks payoff moment near payoffSceneId", () => {
    const issues = validateNarrativePayoff(buildMainRecipe(), {
      abstraction,
      timelineIndex,
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-PAYOFF-UNDELIVERED");
    assert.equal(issues[0].sceneId, "clip01_scene002");
  });

  it("passes when retentionRole payoff is near payoffSceneId", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: "payoff_01",
        techniqueId: "music_drop",
        outputId: "main_16x9",
        outputStartSec: 175,
        outputEndSec: 178,
        retentionRole: "payoff",
        reason: "Payoff kulminacji",
        confidence: 0.8,
      }],
    });

    const issues = validateNarrativePayoff(recipe, { abstraction, timelineIndex });
    assert.equal(issues.length, 0);
  });

  it("NAR-PAYOFF-UNDELIVERED when payoff exists but far from payoffSceneId", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: "payoff_far",
        techniqueId: "music_drop",
        outputId: "main_16x9",
        outputStartSec: 30,
        outputEndSec: 33,
        retentionRole: "payoff",
        reason: "Payoff w złym miejscu",
        confidence: 0.8,
      }],
    });

    const issues = validateNarrativePayoff(recipe, { abstraction, timelineIndex });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-PAYOFF-UNDELIVERED");
  });

  it("skips when no structural openLoops", () => {
    const issues = validateNarrativePayoff(buildMainRecipe(), {
      abstraction: { L3: { sessionSummary: "tekst" } },
      timelineIndex,
    });
    assert.equal(issues.length, 0);
  });

  it("maps payoffSceneId through dead_air cuts when wordIndexes provided", () => {
    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
        { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
      ],
    }];
    const recipe = buildMainRecipe({
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 240,
          audioInSec: 0,
          audioOutSec: 240,
          audioPolicy: "from_video_ref",
          cuts: [{
            startWordId: "clip01_w001",
            endWordId: "clip01_w002",
            reason: "dead_air",
          }],
        }],
      }],
      creativeMoments: [{
        momentId: "payoff_01",
        techniqueId: "music_drop",
        outputId: "main_16x9",
        outputStartSec: 176,
        outputEndSec: 179,
        retentionRole: "payoff",
        reason: "Payoff po dead air cut",
        confidence: 0.8,
      }],
    });

    const withWordIndexes = validateNarrativePayoff(recipe, {
      abstraction,
      timelineIndex,
      wordIndexes,
      toleranceSec: 2,
    });
    assert.equal(withWordIndexes.length, 0);

    const withoutWordIndexes = validateNarrativePayoff(recipe, {
      abstraction,
      timelineIndex,
      toleranceSec: 2,
    });
    assert.equal(withoutWordIndexes.length, 1);
    assert.equal(withoutWordIndexes[0].code, "NAR-PAYOFF-UNDELIVERED");
  });
});

describe("validateNarrativePayoffMissing", () => {
  it("NAR-PAYOFF-MISSING when final L2 segment has no payoff creativeMoment in output range", () => {
    const issues = validateNarrativePayoffMissing(buildMainRecipe({
      narrativeProfile: { mode: "internet_documentary" },
    }), { abstraction });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-PAYOFF-MISSING");
    assert.equal(issues[0].severity, "warning");
    assert.equal(issues[0].outputId, "main_16x9");
    assert.match(issues[0].message, /seg002/);
  });

  it("skips NAR-PAYOFF-MISSING when no openLoops and no narrativeProfile.mode", () => {
    const issues = validateNarrativePayoffMissing(buildMainRecipe(), {
      abstraction: {
        L2: abstraction.L2,
        L3: { sessionSummary: "tekst" },
      },
    });
    assert.equal(issues.length, 0);
  });

  it("passes when textOverlays role payoff is within climax L2 output range", () => {
    const recipe = buildMainRecipe({
      outputs: [{
        ...buildMainRecipe().outputs[0],
        timeline: [{
          ...buildMainRecipe().outputs[0].timeline[0],
          textOverlays: [{
            overlayId: "payoff_text",
            text: "Reveal!",
            role: "payoff",
            style: "emphasis",
            outputStartSec: 175,
            outputEndSec: 180,
          }],
        }],
      }],
    });

    const issues = validateNarrativePayoffMissing(recipe, { abstraction });
    assert.equal(issues.length, 0);
  });

  it("passes when retentionRole payoff is within final L2 output range", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: "payoff_01",
        techniqueId: "music_drop",
        outputId: "main_16x9",
        outputStartSec: 175,
        outputEndSec: 178,
        retentionRole: "payoff",
        reason: "Payoff kulminacji",
        confidence: 0.8,
      }],
    });

    const issues = validateNarrativePayoffMissing(recipe, { abstraction });
    assert.equal(issues.length, 0);
  });

  it("uses narrativeRole climax segment instead of last L2 when present", () => {
    const abstractionWithClimax = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        {
          segmentId: "seg002",
          sceneIds: ["clip01_scene002"],
          startSec: 120,
          endSec: 200,
          narrativeRole: "climax",
        },
        { segmentId: "seg003", sceneIds: ["clip01_scene002"], startSec: 200, endSec: 240 },
      ],
      L3: {
        openLoops: [{
          loopId: "loop_climax",
          kind: "payoff_tease",
          setupSceneId: "clip01_scene001",
          payoffSceneId: "clip01_scene002",
        }],
      },
    };

    const recipeWithPayoffInClimax = buildMainRecipe({
      creativeMoments: [{
        momentId: "payoff_01",
        techniqueId: "music_drop",
        outputId: "main_16x9",
        outputStartSec: 160,
        outputEndSec: 163,
        retentionRole: "payoff",
        reason: "Payoff kulminacji",
        confidence: 0.8,
      }],
    });

    const issuesClimaxCovered = validateNarrativePayoffMissing(
      recipeWithPayoffInClimax,
      { abstraction: abstractionWithClimax },
    );
    assert.equal(issuesClimaxCovered.length, 0);

    const recipeWithPayoffOnlyInTail = buildMainRecipe({
      creativeMoments: [{
        momentId: "payoff_01",
        techniqueId: "music_drop",
        outputId: "main_16x9",
        outputStartSec: 220,
        outputEndSec: 223,
        retentionRole: "payoff",
        reason: "Payoff w tail",
        confidence: 0.8,
      }],
    });

    const issuesMissingInClimax = validateNarrativePayoffMissing(
      recipeWithPayoffOnlyInTail,
      { abstraction: abstractionWithClimax },
    );
    assert.equal(issuesMissingInClimax.length, 1);
    assert.equal(issuesMissingInClimax[0].code, "NAR-PAYOFF-MISSING");
    assert.match(issuesMissingInClimax[0].message, /seg002/);
  });

  it("skips when no L2 abstraction", () => {
    const issues = validateNarrativePayoffMissing(buildMainRecipe(), {
      abstraction: { L3: { sessionSummary: "tekst" } },
    });
    assert.equal(issues.length, 0);
  });

  it("ignores payoff moments on non-main outputs", () => {
    const recipe = buildMainRecipe({
      outputs: [
        {
          outputId: "main_16x9",
          outputKind: "main",
          format: "16:9",
          timeline: buildMainRecipe().outputs[0].timeline,
        },
        {
          outputId: "short_9x16",
          outputKind: "short",
          format: "9:16",
          timeline: [],
        },
      ],
      creativeMoments: [{
        momentId: "payoff_short",
        techniqueId: "music_drop",
        outputId: "short_9x16",
        outputStartSec: 175,
        outputEndSec: 178,
        retentionRole: "payoff",
        reason: "Payoff short only",
        confidence: 0.8,
      }],
    });

    const issues = validateNarrativePayoffMissing(recipe, { abstraction });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-PAYOFF-MISSING");
  });

  it("fires NAR-PAYOFF-MISSING when openLoops present even without narrativeProfile.mode", () => {
    const issues = validateNarrativePayoffMissing(buildMainRecipe(), { abstraction });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-PAYOFF-MISSING");
  });
});

describe("validateNarrativeBeatSpam", () => {
  it("NAR-BEAT-SPAM for enrich_beat_* in slow L2 segment", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: {
        segments: [{ l2SegmentId: "seg002", rhythm: "slow" }],
      },
      creativeMoments: [
        {
          momentId: "enrich_beat_01",
          techniqueId: "zoom_slow_push",
          outputId: "main_16x9",
          outputStartSec: 150,
          outputEndSec: 151,
          retentionRole: "beat",
          reason: "enrich",
          confidence: 0.7,
        },
        {
          momentId: "enrich_beat_02",
          techniqueId: "ken_burns_light",
          outputId: "main_16x9",
          outputStartSec: 170,
          outputEndSec: 171,
          retentionRole: "beat",
          reason: "enrich",
          confidence: 0.7,
        },
      ],
    });

    const issues = validateNarrativeBeatSpam(recipe, { abstraction });
    assert.ok(issues.some((issue) => issue.code === "NAR-BEAT-SPAM"));
    assert.match(issues[0].message, /enrich_beat_/);
  });

  it("NAR-BEAT-SPAM when more than one beat in low retentionIntensity segment", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: {
        segments: [{ l2SegmentId: "seg002", retentionIntensity: "low" }],
      },
      creativeMoments: [
        {
          momentId: "beat_a",
          techniqueId: "zoom_slow_push",
          outputId: "main_16x9",
          outputStartSec: 150,
          outputEndSec: 151,
          retentionRole: "beat",
          reason: "beat",
          confidence: 0.7,
        },
        {
          momentId: "beat_b",
          techniqueId: "ken_burns_light",
          outputId: "main_16x9",
          outputStartSec: 170,
          outputEndSec: 171,
          retentionRole: "beat",
          reason: "beat",
          confidence: 0.7,
        },
      ],
    });

    const issues = validateNarrativeBeatSpam(recipe, { abstraction });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-BEAT-SPAM");
  });

  it("passes for beats outside slow segments", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: {
        segments: [{ l2SegmentId: "seg002", rhythm: "slow" }],
      },
      creativeMoments: [{
        momentId: "beat_intro",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 40,
        outputEndSec: 41,
        retentionRole: "beat",
        reason: "beat",
        confidence: 0.7,
      }],
    });

    const issues = validateNarrativeBeatSpam(recipe, { abstraction });
    assert.equal(issues.length, 0);
  });
});

describe("validateNarrativeBreathBeat", () => {
  it("NAR-BREATH-BEAT when beat in L2 breath segment", () => {
    const abstractionBreath = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        {
          segmentId: "seg002",
          sceneIds: ["clip01_scene002"],
          startSec: 120,
          endSec: 240,
          narrativeRole: "breath",
        },
      ],
    };
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: "beat_breath",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 150,
        outputEndSec: 151,
        retentionRole: "beat",
        reason: "beat w oddechu",
        confidence: 0.7,
      }],
    });

    const issues = validateNarrativeBreathBeat(recipe, {
      abstraction: abstractionBreath,
      timelineIndex,
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-BREATH-BEAT");
    assert.match(issues[0].message, /breath/);
  });

  it("NAR-BREATH-BEAT when snap_zoom in slow rhythm L2 segment", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: {
        segments: [{ l2SegmentId: "seg002", rhythm: "slow" }],
      },
      creativeMoments: [{
        momentId: "snap_slow",
        techniqueId: "snap_zoom",
        outputId: "main_16x9",
        outputStartSec: 150,
        outputEndSec: 151,
        reason: "snap w slow",
        confidence: 0.7,
      }],
    });

    const issues = validateNarrativeBreathBeat(recipe, { abstraction, timelineIndex });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-BREATH-BEAT");
    assert.match(issues[0].message, /slow/);
  });

  it("passes when no breath or slow segments", () => {
    const issues = validateNarrativeBreathBeat(buildMainRecipe(), { abstraction, timelineIndex });
    assert.equal(issues.length, 0);
  });
});

describe("validateNarrativeClosureSpam", () => {
  const abstractionResolution = {
    L2: [
      { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
      {
        segmentId: "seg002",
        sceneIds: ["clip01_scene002"],
        startSec: 120,
        endSec: 240,
        narrativeRole: "resolution",
      },
    ],
  };

  it("NAR-CLOSURE-SPAM for enrich_beat_* in resolution segment", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: "enrich_beat_closure",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 150,
        outputEndSec: 151,
        retentionRole: "beat",
        reason: "enrich",
        confidence: 0.7,
      }],
    });

    const issues = validateNarrativeClosureSpam(recipe, {
      abstraction: abstractionResolution,
      timelineIndex,
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-CLOSURE-SPAM");
    assert.match(issues[0].message, /enrich_beat_/);
  });

  it("NAR-CLOSURE-SPAM when more than one beat in resolution segment", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [
        {
          momentId: "beat_a",
          techniqueId: "zoom_slow_push",
          outputId: "main_16x9",
          outputStartSec: 140,
          outputEndSec: 141,
          retentionRole: "beat",
          reason: "beat",
          confidence: 0.7,
        },
        {
          momentId: "beat_b",
          techniqueId: "ken_burns_light",
          outputId: "main_16x9",
          outputStartSec: 170,
          outputEndSec: 171,
          retentionRole: "beat",
          reason: "beat",
          confidence: 0.7,
        },
      ],
    });

    const issues = validateNarrativeClosureSpam(recipe, {
      abstraction: abstractionResolution,
      timelineIndex,
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-CLOSURE-SPAM");
    assert.match(issues[0].message, /2 beat/);
  });

  it("passes with single beat in resolution segment", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: "beat_ok",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 150,
        outputEndSec: 151,
        retentionRole: "beat",
        reason: "beat",
        confidence: 0.7,
      }],
    });

    const issues = validateNarrativeClosureSpam(recipe, {
      abstraction: abstractionResolution,
      timelineIndex,
    });
    assert.equal(issues.length, 0);
  });
});

describe("validateNarrativeCallbackUndelivered", () => {
  const abstractionCallback = {
    L2: abstraction.L2,
    L3: {
      openLoops: [{
        loopId: "loop_cb",
        kind: "callback",
        setupSceneId: "clip01_scene001",
        payoffSceneId: "clip01_scene002",
        teaseText: "Callback tease",
      }],
    },
  };

  it("NAR-CALLBACK-UNDELIVERED when callback loop lacks match_cut or payoff overlay", () => {
    const issues = validateNarrativeCallbackUndelivered(buildMainRecipe(), {
      abstraction: abstractionCallback,
      timelineIndex,
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-CALLBACK-UNDELIVERED");
    assert.equal(issues[0].sceneId, "clip01_scene002");
  });

  it("passes when match_cut is near payoffSceneId", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: "match_cb",
        techniqueId: "match_cut",
        outputId: "main_16x9",
        outputStartSec: 175,
        outputEndSec: 176,
        reason: "callback match",
        confidence: 0.8,
      }],
    });

    const issues = validateNarrativeCallbackUndelivered(recipe, {
      abstraction: abstractionCallback,
      timelineIndex,
    });
    assert.equal(issues.length, 0);
  });

  it("passes when payoff overlay is on payoffSceneId segment", () => {
    const recipe = buildMainRecipe({
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          videoInSec: 0,
          videoOutSec: 240,
          audioInSec: 0,
          audioOutSec: 240,
          audioPolicy: "from_video_ref",
          textOverlays: [{
            overlayId: "payoff_cb",
            text: "Callback payoff",
            role: "payoff",
            style: "emphasis",
            outputStartSec: 175,
            outputEndSec: 180,
          }],
        }],
      }],
    });

    const issues = validateNarrativeCallbackUndelivered(recipe, {
      abstraction: abstractionCallback,
      timelineIndex,
    });
    assert.equal(issues.length, 0);
  });
});

describe("validateNarrativeDramaticPauseCuts", () => {
  const wordIndexes = [{
    clipId: "clip01",
    words: [
      { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
      { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
    ],
  }];

  it("NAR-DRAMATIC-PAUSE-CUT for dead_air cut in preserve L2 segment", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: {
        silencePolicy: "trim_dead_air",
        segments: [{ l2SegmentId: "seg001", silencePolicy: "preserve" }],
      },
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
          cuts: [{
            startWordId: "clip01_w001",
            endWordId: "clip01_w002",
            reason: "dead_air",
          }],
        }],
      }],
    });

    const issues = validateNarrativeDramaticPauseCuts(recipe, {
      abstraction,
      timelineIndex,
      wordIndexes,
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-DRAMATIC-PAUSE-CUT");
    assert.equal(issues[0].severity, "error");
    assert.match(issues[0].message, /preserve/);
  });

  it("NAR-DRAMATIC-PAUSE-CUT for dead_air cut overlapping dramatic_pause hint", () => {
    const recipe = buildMainRecipe({
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
          cuts: [{
            startWordId: "clip01_w001",
            endWordId: "clip01_w002",
            reason: "dead_air",
          }],
        }],
      }],
    });

    const audioIndex = {
      clips: [{
        clipId: "clip01",
        deadAirHints: [{
          startSec: 2,
          endSec: 6,
          source: "both",
          kind: "dramatic_pause",
        }],
      }],
    };

    const issues = validateNarrativeDramaticPauseCuts(recipe, {
      abstraction,
      timelineIndex,
      wordIndexes,
      audioIndex,
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-DRAMATIC-PAUSE-CUT");
    assert.match(issues[0].message, /dramatic_pause/);
  });

  it("NAR-DRAMATIC-PAUSE-CUT uses silenceKind from buildAudioIndexSummary tagging", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: { silencePolicy: "preserve" },
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
          cuts: [{
            startWordId: "clip01_w001",
            endWordId: "clip01_w002",
            reason: "dead_air",
          }],
        }],
      }],
    });

    const audioIndex = {
      clips: [{
        clipId: "clip01",
        deadAirHints: [{
          startSec: 2,
          endSec: 6,
          source: "both",
        }],
      }],
    };

    const issues = validateNarrativeDramaticPauseCuts(recipe, {
      abstraction,
      timelineIndex,
      wordIndexes,
      audioIndex,
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-DRAMATIC-PAUSE-CUT");
    assert.match(issues[0].message, /dramatic_pause/);
  });
});

describe("validateNarrative", () => {
  it("aggregates all NAR validators", () => {
    const issues = validateNarrative(buildMainRecipe({
      narrativeProfile: {
        segments: [{ l2SegmentId: "seg002", rhythm: "slow" }],
      },
      creativeMoments: [{
        momentId: "enrich_beat_01",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 150,
        outputEndSec: 151,
        retentionRole: "beat",
        reason: "enrich",
        confidence: 0.7,
      }],
    }), { abstraction, timelineIndex });

    assert.ok(issues.some((issue) => issue.code === "NAR-PAYOFF-UNDELIVERED"));
    assert.ok(issues.some((issue) => issue.code === "NAR-BEAT-SPAM"));
  });
});
