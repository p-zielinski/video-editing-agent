import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkTimelineForL2, sceneSummaryInput, drillDownSceneDetails } from "../lib/abstraction-chunking.js";

describe("abstraction chunking", () => {
  it("groups scenes into L2 segments", () => {
    const scenes = [];
    for (let i = 0; i < 20; i += 1) {
      scenes.push({
        sceneId: `clip01_scene${String(i + 1).padStart(3, "0")}`,
        clipId: "clip01",
        startSec: i * 60,
        endSec: (i + 1) * 60,
        durationSec: 60,
      });
    }

    const segments = chunkTimelineForL2(scenes, { targetSegmentSec: 300, minSegmentSec: 120 });
    assert.ok(segments.length >= 2);
    assert.equal(segments[0].sceneIds.length > 0, true);
  });

  it("builds scene summary input from words and captions", () => {
    const scene = {
      sceneId: "clip01_scene001",
      startSec: 0,
      endSec: 10,
      durationSec: 10,
    };
    const words = [
      { word: "hej", start: 1, end: 1.2, isFiller: false },
      { word: "yyy", start: 2, end: 2.2, isFiller: true },
    ];
    const captions = [{ sceneId: "clip01_scene001", caption: "vlog w pokoju" }];

    const input = sceneSummaryInput(scene, words, captions);
    assert.match(input.transcript, /hej/);
    assert.deepEqual(input.fillers, ["yyy"]);
    assert.match(input.visual, /pokoju/);
  });

  it("drillDownSceneDetails returns L0 data only for selected sceneIds", () => {
    const timelineIndex = {
      scenes: [
        { sceneId: "clip01_scene001", startSec: 0, endSec: 10, durationSec: 10 },
        { sceneId: "clip01_scene002", startSec: 10, endSec: 20, durationSec: 10 },
      ],
      words: [
        { word: "hej", start: 1, end: 1.2, isFiller: false },
        { word: "tam", start: 12, end: 12.2, isFiller: false },
      ],
      visionCaptions: [
        { sceneId: "clip01_scene001", caption: "pokój" },
        { sceneId: "clip01_scene002", caption: "ulica" },
      ],
    };

    const details = drillDownSceneDetails(timelineIndex, ["clip01_scene001"]);
    assert.equal(details.length, 1);
    assert.equal(details[0].sceneId, "clip01_scene001");
    assert.match(details[0].transcript, /hej/);
    assert.match(details[0].visual, /pokój/);
    assert.equal(details.some((d) => d.sceneId === "clip01_scene002"), false);
  });
});
