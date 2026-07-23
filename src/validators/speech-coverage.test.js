import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSpeechCoverage } from "./speech-coverage.js";

function baseRecipe(overrides = {}) {
  return {
    batchContext: { inputMode: "multi_clip_day", requiredFormats: ["16:9"] },
    clipRegistry: [
      {
        clipId: "clip01",
        fileName: "a.mov",
        durationSec: 60,
        sortIndex: 0,
        clipRole: "aroll_primary",
        hasSpeech: true,
        speechWordCount: 40,
      },
      {
        clipId: "clip16",
        fileName: "long-talk.mov",
        durationSec: 300,
        sortIndex: 15,
        clipRole: "aroll_primary",
        hasSpeech: true,
        speechWordCount: 200,
      },
      {
        clipId: "clip02",
        fileName: "b.mov",
        durationSec: 50,
        sortIndex: 1,
        clipRole: "broll_pool",
        hasSpeech: false,
        speechWordCount: 0,
      },
    ],
    outputs: [{
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      title: "Main",
      timeline: [],
    }],
    ...overrides,
  };
}

function arollSegment(clipId, segmentId = `s_${clipId}`) {
  return {
    segmentId,
    segmentRole: "aroll",
    videoRef: { clipId, sceneId: `${clipId}_scene001` },
    audioRef: { clipId, sceneId: `${clipId}_scene001` },
    videoInSec: 0,
    videoOutSec: 20,
    audioInSec: 0,
    audioOutSec: 20,
    audioPolicy: "from_video_ref",
  };
}

describe("validateSpeechCoverage (V25-SPEECH-COVERAGE)", () => {
  it("errors when dominant aroll_primary speech clip is omitted from main (clip16 case)", () => {
    const recipe = baseRecipe({
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Main",
        timeline: [arollSegment("clip01")],
      }],
    });

    const issues = validateSpeechCoverage(recipe);
    const issue = issues.find((i) => i.code === "V25-SPEECH-COVERAGE");
    assert.ok(issue);
    assert.equal(issue.severity, "error");
    assert.equal(issue.clipId, "clip16");
  });

  it("passes when top speech aroll_primary appears via videoRef", () => {
    const recipe = baseRecipe({
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Main",
        timeline: [
          arollSegment("clip01"),
          arollSegment("clip16"),
        ],
      }],
    });

    const issues = validateSpeechCoverage(recipe);
    assert.equal(issues.filter((i) => i.code === "V25-SPEECH-COVERAGE").length, 0);
  });

  it("passes when top speech clip appears only as audioRef (VO / broll under speech)", () => {
    const recipe = baseRecipe({
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Main",
        timeline: [
          arollSegment("clip01"),
          {
            segmentId: "b_under_speech",
            segmentRole: "broll",
            videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
            audioRef: { clipId: "clip16", sceneId: "clip16_scene001" },
            videoInSec: 0,
            videoOutSec: 15,
            audioInSec: 10,
            audioOutSec: 25,
            audioPolicy: "from_audio_ref",
          },
        ],
      }],
    });

    const issues = validateSpeechCoverage(recipe);
    assert.equal(issues.filter((i) => i.code === "V25-SPEECH-COVERAGE").length, 0);
  });

  it("ignores non-aroll_primary clips even with high speechWordCount", () => {
    const recipe = baseRecipe({
      clipRegistry: [
        {
          clipId: "clip01",
          fileName: "a.mov",
          durationSec: 60,
          sortIndex: 0,
          clipRole: "aroll_primary",
          hasSpeech: true,
          speechWordCount: 50,
        },
        {
          clipId: "vo01",
          fileName: "vo.m4a",
          durationSec: 200,
          sortIndex: 1,
          clipRole: "narration_track",
          hasSpeech: true,
          speechWordCount: 200,
        },
      ],
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Main",
        timeline: [arollSegment("clip01")],
      }],
    });

    const issues = validateSpeechCoverage(recipe);
    assert.equal(issues.filter((i) => i.code === "V25-SPEECH-COVERAGE").length, 0);
  });

  it("returns no issues when no clip reaches 30% of batch speech", () => {
    const recipe = baseRecipe({
      clipRegistry: [
        {
          clipId: "clip01",
          sortIndex: 0,
          clipRole: "aroll_primary",
          hasSpeech: true,
          speechWordCount: 20,
          fileName: "a.mov",
          durationSec: 60,
        },
        {
          clipId: "clip02",
          sortIndex: 1,
          clipRole: "aroll_primary",
          hasSpeech: true,
          speechWordCount: 20,
          fileName: "b.mov",
          durationSec: 60,
        },
        {
          clipId: "clip03",
          sortIndex: 2,
          clipRole: "aroll_primary",
          hasSpeech: true,
          speechWordCount: 20,
          fileName: "c.mov",
          durationSec: 60,
        },
        {
          clipId: "clip04",
          sortIndex: 3,
          clipRole: "aroll_primary",
          hasSpeech: true,
          speechWordCount: 20,
          fileName: "d.mov",
          durationSec: 60,
        },
      ],
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        title: "Main",
        timeline: [arollSegment("clip01")],
      }],
    });

    const issues = validateSpeechCoverage(recipe);
    assert.equal(issues.length, 0);
  });
});
