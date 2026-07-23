import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachWordsToScenes, buildTimelineIndex } from "../lib/timeline-index.js";

describe("timeline index", () => {
  it("attaches word range to scenes with speech", () => {
    const scenes = [
      {
        sceneId: "clip01_scene001",
        clipId: "clip01",
        sourcePath: "/a.mp4",
        startSec: 0,
        endSec: 10,
        durationSec: 10,
        aspectRatio: "16:9",
        resolution: { w: 1920, h: 1080 },
      },
    ];

    const words = [
      { wordId: "clip01_w00001", word: "cześć", start: 1, end: 1.5 },
      { wordId: "clip01_w00002", word: "yyy", start: 2, end: 2.3, isFiller: true },
    ];

    const updated = attachWordsToScenes(scenes, words);
    assert.equal(updated[0].hasSpeech, true);
    assert.equal(updated[0].wordRange.firstWordId, "clip01_w00001");
    assert.equal(updated[0].wordRange.lastWordId, "clip01_w00002");
  });

  it("does not attach words from other clips when local clocks overlap", () => {
    const scenes = [
      {
        sceneId: "clip16_scene001",
        clipId: "clip16",
        sourcePath: "/clip16.mp4",
        startSec: 0,
        endSec: 825,
        durationSec: 825,
        aspectRatio: "16:9",
        resolution: { w: 1920, h: 1080 },
      },
    ];

    const words = [
      { wordId: "clip01_w00001", clipId: "clip01", word: "hello", start: 1, end: 1.5 },
      { wordId: "clip01_w00002", clipId: "clip01", word: "world", start: 100, end: 100.5 },
      { wordId: "clip16_w00001", clipId: "clip16", word: "dzień", start: 10, end: 10.4 },
      { wordId: "clip16_w00002", clipId: "clip16", word: "dobry", start: 200, end: 200.5 },
    ];

    const updated = attachWordsToScenes(scenes, words);
    assert.equal(updated[0].hasSpeech, true);
    assert.equal(updated[0].wordRange.firstWordId, "clip16_w00001");
    assert.equal(updated[0].wordRange.lastWordId, "clip16_w00002");
    assert.match(updated[0].wordRange.firstWordId, /^clip16_w/);
    assert.match(updated[0].wordRange.lastWordId, /^clip16_w/);
  });

  it("scopes words by wordId prefix when clipId is absent on words", () => {
    const scenes = [
      {
        sceneId: "clip16_scene001",
        clipId: "clip16",
        sourcePath: "/clip16.mp4",
        startSec: 0,
        endSec: 825,
        durationSec: 825,
        aspectRatio: "16:9",
        resolution: { w: 1920, h: 1080 },
      },
    ];

    const words = [
      { wordId: "clip01_w00001", word: "hello", start: 1, end: 1.5 },
      { wordId: "clip16_w00001", word: "dzień", start: 10, end: 10.4 },
      { wordId: "clip16_w00002", word: "dobry", start: 200, end: 200.5 },
    ];

    const updated = attachWordsToScenes(scenes, words);
    assert.equal(updated[0].hasSpeech, true);
    assert.equal(updated[0].wordRange.firstWordId, "clip16_w00001");
    assert.equal(updated[0].wordRange.lastWordId, "clip16_w00002");
  });

  it("builds full timeline index", () => {
    const catalog = {
      batchId: "b1",
      clips: [{ clipId: "clip01", sourcePath: "/a.mp4", durationSec: 10, aspectRatio: "16:9" }],
      scenes: [
        {
          sceneId: "clip01_scene001",
          clipId: "clip01",
          sourcePath: "/a.mp4",
          startSec: 0,
          endSec: 10,
          durationSec: 10,
          aspectRatio: "16:9",
          resolution: { w: 1920, h: 1080 },
        },
      ],
    };

    const index = buildTimelineIndex({
      batchId: "b1",
      catalog,
      wordIndexes: [
        {
          words: [
            { wordId: "clip01_w00001", word: "test", start: 1, end: 2, isFiller: false },
          ],
        },
      ],
      keyframeSets: [{ keyframes: [{ timestampSec: 1, sceneId: "clip01_scene001", trigger: "speech" }] }],
      visionSets: [{ captions: [{ timestampSec: 1, sceneId: "clip01_scene001", caption: "osoba mówi" }] }],
    });

    assert.equal(index.words.length, 1);
    assert.equal(index.scenes[0].hasSpeech, true);
    assert.equal(index.clips[0].aspectRatio, "16:9");
    assert.equal(index.keyframes.length, 1);
    assert.equal(index.visionCaptions.length, 1);
    assert.equal(index.stats.fillerWordCount, 0);
  });
});
