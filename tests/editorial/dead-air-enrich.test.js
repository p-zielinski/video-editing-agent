import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRecipeSilenceBeatFromDeadAir,
  hasSilenceBeatNearSec,
} from "../../src/editorial/dead-air-enrich.js";

describe("dead-air-enrich", () => {
  it("hasSilenceBeatNearSec detects nearby silence_beat moments", () => {
    const moments = [{
      techniqueId: "silence_beat",
      outputStartSec: 40,
    }];
    assert.equal(hasSilenceBeatNearSec(moments, 40.5, 0.8), true);
    assert.equal(hasSilenceBeatNearSec(moments, 50, 0.8), false);
  });

  it("enrichRecipeSilenceBeatFromDeadAir adds enrich_silence moments", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 120,
          audioInSec: 0,
          audioOutSec: 120,
          audioPolicy: "from_video_ref",
        }],
      }],
      creativeMoments: [],
    };

    const audioIndex = {
      clips: [{
        clipId: "clip01",
        deadAirHints: [{
          startSec: 30,
          endSec: 33,
          source: "both",
        }],
      }],
    };

    const moments = enrichRecipeSilenceBeatFromDeadAir(recipe, { audioIndex });
    assert.ok(moments.some((moment) => moment.momentId.startsWith("enrich_silence_")));
    assert.equal(moments.find((moment) => moment.momentId.startsWith("enrich_silence_"))?.techniqueId, "silence_beat");
  });
});
