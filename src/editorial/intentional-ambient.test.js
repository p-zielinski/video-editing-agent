import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AMBIENT_SHOWCASE_DUCK_DB,
  INTENTIONAL_AMBIENT_REJECT_REASON,
  applyAmbientEnhancementRejects,
  applyAmbientShowcaseMusicDucking,
  collectSegmentTranscript,
  detectsIntentionalAmbientCue,
  enrichIntentionalAmbient,
  markPreserveAmbientSegments,
  mergeAmbientShowcaseDucking,
  softDisableSilenceBeatOnPreserveAmbient,
} from "./intentional-ambient.js";
import { GAP_DUCK_DB, SPEECH_DUCK_DB } from "./speech-ducking.js";

function makeArollSeg({
  segmentId = "seg01",
  clipId = "clip01",
  audioIn = 0,
  audioOut = 10,
  outputStart = 0,
  outputEnd = 10,
  preserveAmbientAudio,
} = {}) {
  return {
    segmentId,
    segmentRole: "aroll",
    videoRef: { clipId, sceneId: `${clipId}_scene001` },
    audioRef: { clipId, sceneId: `${clipId}_scene001` },
    videoInSec: audioIn,
    videoOutSec: audioOut,
    audioInSec: audioIn,
    audioOutSec: audioOut,
    outputStartSec: outputStart,
    outputEndSec: outputEnd,
    audioPolicy: "from_video_ref",
    ...(preserveAmbientAudio != null ? { preserveAmbientAudio } : {}),
  };
}

function makeRecipe(timeline, extras = {}) {
  return {
    outputs: [{
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      title: "Test",
      timeline,
    }],
    creativeMoments: [],
    audioEnhancementDecisions: [],
    audioMixPlan: {
      musicBed: { trackId: "bed01", volumeDb: -18, duckingDb: SPEECH_DUCK_DB },
      segments: [{
        outputId: "main_16x9",
        musicInSec: 0,
        musicOutSec: 20,
        duckUnderVoice: true,
        duckingWindows: [
          { startSec: 0, endSec: 5, duckingDb: GAP_DUCK_DB },
          { startSec: 5, endSec: 10, duckingDb: SPEECH_DUCK_DB },
          { startSec: 10, endSec: 20, duckingDb: GAP_DUCK_DB },
        ],
      }],
    },
    ...extras,
  };
}

describe("intentional-ambient", () => {
  it("detectsIntentionalAmbientCue matches PL listen/birds phrases", () => {
    assert.equal(
      detectsIntentionalAmbientCue("posłuchajcie jak tu pięknie słychać śpiew ptaków"),
      true,
    );
    assert.equal(detectsIntentionalAmbientCue("listen to the birds"), true);
    assert.equal(detectsIntentionalAmbientCue("hello world today"), false);
  });

  it("collectSegmentTranscript joins words in segment range", () => {
    const segment = makeArollSeg({ audioIn: 1, audioOut: 5 });
    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { wordId: "w0", start: 0, end: 0.5, text: "skip" },
        { wordId: "w1", start: 1.0, end: 1.5, text: "posłuchajcie" },
        { wordId: "w2", start: 2.0, end: 2.5, text: "ptaków" },
        { wordId: "w3", start: 8.0, end: 8.5, text: "later" },
      ],
    }];
    assert.match(collectSegmentTranscript(segment, wordIndexes), /posłuchajcie.*ptaków/);
  });

  it("markPreserveAmbientSegments flags cue segment and silence follow-up", () => {
    const recipe = makeRecipe([
      makeArollSeg({
        segmentId: "seg_cue",
        audioIn: 0,
        audioOut: 5,
        outputStart: 0,
        outputEnd: 5,
      }),
      makeArollSeg({
        segmentId: "seg_birds",
        audioIn: 5,
        audioOut: 12,
        outputStart: 5,
        outputEnd: 12,
      }),
    ]);
    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { wordId: "w1", start: 0.5, end: 1.2, text: "posłuchajcie" },
        { wordId: "w2", start: 1.3, end: 2.0, text: "ptaków" },
        { wordId: "w3", start: 11.0, end: 11.2, text: "ok" },
      ],
    }];

    const marked = markPreserveAmbientSegments(recipe, { wordIndexes });
    assert.deepEqual(marked, ["seg_cue", "seg_birds"]);
    assert.equal(recipe.outputs[0].timeline[0].preserveAmbientAudio, true);
    assert.equal(recipe.outputs[0].timeline[1].preserveAmbientAudio, true);
  });

  it("applyAmbientEnhancementRejects adds reject and flips auto-accept", () => {
    const recipe = makeRecipe([
      makeArollSeg({ segmentId: "seg_a", clipId: "clip_a", preserveAmbientAudio: true }),
      makeArollSeg({
        segmentId: "seg_b",
        clipId: "clip_b",
        outputStart: 10,
        outputEnd: 20,
        preserveAmbientAudio: true,
      }),
      makeArollSeg({
        segmentId: "seg_c",
        clipId: "clip_c",
        outputStart: 20,
        outputEnd: 30,
        preserveAmbientAudio: true,
      }),
    ], {
      audioEnhancementDecisions: [
        {
          candidateId: "enh_clip_b",
          clipId: "clip_b",
          action: "accept",
          dialogueValue: "useful",
          reason: "Auto-accept: speech A-roll used in timeline (DPDFNet ≠ music ducking)",
        },
        {
          candidateId: "enh_clip_c",
          clipId: "clip_c",
          action: "accept",
          dialogueValue: "essential",
          reason: "Director: dialog essential, SNR repairable",
        },
      ],
    });

    const changed = applyAmbientEnhancementRejects(recipe);
    assert.equal(changed, 2);
    const byClip = Object.fromEntries(
      recipe.audioEnhancementDecisions.map((d) => [d.clipId, d]),
    );
    assert.equal(byClip.clip_a.action, "reject");
    assert.equal(byClip.clip_a.reason, INTENTIONAL_AMBIENT_REJECT_REASON);
    assert.equal(byClip.clip_b.action, "reject");
    assert.equal(byClip.clip_b.reason, INTENTIONAL_AMBIENT_REJECT_REASON);
    assert.equal(byClip.clip_c.action, "accept", "director accept left intact");
  });

  it("softDisableSilenceBeatOnPreserveAmbient disables overlapping moments", () => {
    const recipe = makeRecipe([
      makeArollSeg({
        segmentId: "seg_amb",
        outputStart: 8,
        outputEnd: 14,
        preserveAmbientAudio: true,
      }),
    ], {
      creativeMoments: [
        {
          momentId: "sb1",
          techniqueId: "silence_beat",
          outputId: "main_16x9",
          outputStartSec: 10,
          outputEndSec: 11,
          reason: "dead air dip",
        },
        {
          momentId: "sb2",
          techniqueId: "silence_beat",
          outputId: "main_16x9",
          outputStartSec: 20,
          outputEndSec: 21,
          reason: "other dip",
        },
      ],
    });

    assert.equal(softDisableSilenceBeatOnPreserveAmbient(recipe), 1);
    assert.equal(recipe.creativeMoments[0].disabled, true);
    assert.equal(recipe.creativeMoments[1].disabled, undefined);
  });

  it("mergeAmbientShowcaseDucking sets duckingDb 0 on showcase without wiping speech ducks", () => {
    const windows = [
      { startSec: 0, endSec: 5, duckingDb: GAP_DUCK_DB },
      { startSec: 5, endSec: 10, duckingDb: SPEECH_DUCK_DB },
      { startSec: 10, endSec: 20, duckingDb: GAP_DUCK_DB },
    ];
    const merged = mergeAmbientShowcaseDucking(windows, [{ start: 10, end: 16 }]);
    assert.ok(merged.some((w) => w.duckingDb === SPEECH_DUCK_DB && w.startSec === 5));
    assert.ok(merged.some(
      (w) => w.duckingDb === AMBIENT_SHOWCASE_DUCK_DB && w.startSec === 10 && w.endSec === 16,
    ));
    assert.ok(merged.some((w) => w.duckingDb === GAP_DUCK_DB && w.startSec === 16));
  });

  it("enrichIntentionalAmbient end-to-end sets preserve, reject, ducking, silence disable", () => {
    const recipe = makeRecipe([
      makeArollSeg({
        segmentId: "seg_cue",
        audioIn: 0,
        audioOut: 8,
        outputStart: 0,
        outputEnd: 8,
      }),
    ], {
      creativeMoments: [{
        momentId: "sb1",
        techniqueId: "silence_beat",
        outputId: "main_16x9",
        outputStartSec: 4,
        outputEndSec: 5,
        reason: "dip",
      }],
      audioEnhancementDecisions: [{
        candidateId: "enh_clip01",
        clipId: "clip01",
        action: "accept",
        dialogueValue: "useful",
        reason: "Auto-accept: speech A-roll used in timeline (DPDFNet ≠ music ducking)",
      }],
    });
    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { wordId: "w1", start: 0.2, end: 1.0, text: "posłuchajcie" },
        { wordId: "w2", start: 1.1, end: 1.8, text: "ptaków" },
      ],
    }];

    const result = enrichIntentionalAmbient(recipe, { wordIndexes });
    assert.deepEqual(result.markedSegments, ["seg_cue"]);
    assert.equal(result.decisionsChanged, 1);
    assert.equal(result.silenceBeatsDisabled, 1);
    assert.equal(result.duckingUpdated, 1);
    assert.equal(recipe.outputs[0].timeline[0].preserveAmbientAudio, true);
    assert.equal(recipe.audioEnhancementDecisions[0].action, "reject");
    assert.equal(recipe.creativeMoments[0].disabled, true);
    assert.ok(
      recipe.audioMixPlan.segments[0].duckingWindows.some(
        (w) => w.duckingDb === AMBIENT_SHOWCASE_DUCK_DB,
      ),
    );
  });

  it("applyAmbientShowcaseMusicDucking is a no-op without music plan", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        timeline: [makeArollSeg({ preserveAmbientAudio: true })],
      }],
    };
    assert.equal(applyAmbientShowcaseMusicDucking(recipe), 0);
  });
});
