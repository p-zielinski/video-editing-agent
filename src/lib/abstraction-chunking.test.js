import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkTimelineForL2, sceneSummaryInput, drillDownSceneDetails, enrichSceneInputWithClipMeta, buildDaySegments, sortScenesByClipOrder } from "../lib/abstraction-chunking.js";

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

  it("caps transcript words in scene summary input", () => {
    const scene = {
      sceneId: "clip01_scene001",
      startSec: 0,
      endSec: 120,
      durationSec: 120,
    };
    const words = Array.from({ length: 200 }, (_, i) => ({
      word: `w${i}`,
      start: i * 0.5,
      end: i * 0.5 + 0.4,
      isFiller: false,
    }));

    const input = sceneSummaryInput(scene, words, []);
    const wordCount = input.transcript.split(/\s+/).filter(Boolean).length;
    assert.equal(wordCount, 120);
  });

  it("samples across long monologue scenes instead of first-N only", () => {
    const scene = {
      sceneId: "clip16_scene001",
      clipId: "clip16",
      startSec: 0,
      endSec: 825,
      durationSec: 825,
    };
    const words = Array.from({ length: 600 }, (_, i) => ({
      wordId: `clip16_w${String(i).padStart(5, "0")}`,
      clipId: "clip16",
      word: `w${i}`,
      start: i * (825 / 600),
      end: (i + 1) * (825 / 600),
      isFiller: false,
    }));

    const input = sceneSummaryInput(scene, words, [], [], { maxWords: 40 });
    const wordCount = input.transcript.split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount > 40, "distributed sampling should exceed single-window cap");
    assert.ok(input.transcript.includes("w599"), "should include end-of-scene speech");
    assert.ok(!input.transcript.includes("w200 w201 w202 w203 w204 w205 w206 w207 w208 w209 w210"),
      "should not be a contiguous head-only slice");
  });

  it("includes objectLabels in scene summary input", () => {
    const scene = {
      sceneId: "clip01_scene001",
      startSec: 0,
      endSec: 10,
      durationSec: 10,
    };
    const input = sceneSummaryInput(scene, [], [], [
      { sceneId: "clip01_scene001", label: "laptop" },
      { sceneId: "clip01_scene001", label: "coffee" },
      { sceneId: "clip01_scene001", label: "laptop" },
    ]);
    assert.deepEqual(input.objectLabels, ["laptop", "coffee"]);
  });

  it("enrichSceneInputWithClipMeta sets clipRole for narration_track", () => {
    const sceneInput = {
      sceneId: "clip03_scene001",
      clipId: "clip03",
      durationSec: 12,
      transcript: "to jest narracja",
      fillers: [],
      visual: "",
    };
    const clipRegistry = [
      {
        clipId: "clip03",
        clipRole: "narration_track",
        mediaType: "audio_only",
        hasSpeech: true,
      },
    ];

    const enriched = enrichSceneInputWithClipMeta(sceneInput, clipRegistry);
    assert.equal(enriched.clipRole, "narration_track");
    assert.equal(enriched.mediaType, "audio_only");
    assert.equal(enriched.hasSpeech, true);
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

  it("sortScenesByClipOrder respects clipRegistry sortIndex", () => {
    const scenes = [
      { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 10 },
      { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 10 },
    ];
    const clipRegistry = [
      { clipId: "clip01", sortIndex: 0 },
      { clipId: "clip02", sortIndex: 1 },
    ];

    const sorted = sortScenesByClipOrder(scenes, clipRegistry);
    assert.equal(sorted[0].clipId, "clip01");
    assert.equal(sorted[1].clipId, "clip02");
  });

  it("buildDaySegments groups clips by calendar day", () => {
    const segments = buildDaySegments([
      { clipId: "clip01", sortIndex: 0, creationTime: "2026-06-29T08:00:00.000Z" },
      { clipId: "clip02", sortIndex: 1, creationTime: "2026-06-29T18:00:00.000Z" },
      { clipId: "clip03", sortIndex: 2, creationTime: "2026-06-30T09:00:00.000Z" },
    ]);

    assert.equal(segments.length, 2);
    assert.deepEqual(segments[0].clipIds, ["clip01", "clip02"]);
    assert.deepEqual(segments[1].clipIds, ["clip03"]);
  });

  it("chunkTimelineForL2 orders scenes by clipRegistry sortIndex", () => {
    const scenes = [
      { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 60, durationSec: 60 },
      { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 60, durationSec: 60 },
    ];
    const clipRegistry = [
      { clipId: "clip01", sortIndex: 0 },
      { clipId: "clip02", sortIndex: 1 },
    ];

    const segments = chunkTimelineForL2(scenes, { clipRegistry, targetSegmentSec: 600 });
    assert.equal(segments[0].sceneIds[0], "clip01_scene001");
  });

  it("chunkTimelineForL2 splits multi-clip day by accumulated duration (~1571s)", () => {
    // Many clips with local clocks restarting at 0 — old endSec-startSec logic never split.
    const scenes = [];
    const clipRegistry = [];
    let totalDuration = 0;
    const clipDurations = [300, 280, 250, 241, 250, 250]; // ~1571s
    for (let c = 0; c < clipDurations.length; c += 1) {
      const clipId = `clip${String(c + 1).padStart(2, "0")}`;
      const dur = clipDurations[c];
      clipRegistry.push({ clipId, sortIndex: c });
      scenes.push({
        sceneId: `${clipId}_scene001`,
        clipId,
        startSec: 0,
        endSec: dur,
        durationSec: dur,
      });
      totalDuration += dur;
    }
    assert.ok(totalDuration >= 1570 && totalDuration <= 1572);

    const segments = chunkTimelineForL2(scenes, {
      clipRegistry,
      targetSegmentSec: 600,
      minSegmentSec: 300,
    });
    assert.ok(segments.length >= 2, `expected ≥2 L2 segments, got ${segments.length}`);
    assert.equal(segments[0].startSec, 0);
    assert.ok(segments[0].endSec >= 300);
    assert.ok(segments[1].startSec === segments[0].endSec);
  });

  it("sceneSummaryInput scopes words by clipId when local times overlap", () => {
    const scene = {
      sceneId: "clip16_scene001",
      clipId: "clip16",
      startSec: 0,
      endSec: 100,
      durationSec: 100,
    };
    const words = [
      { wordId: "clip01_w00001", clipId: "clip01", word: "other", start: 5, end: 5.5, isFiller: false },
      { wordId: "clip16_w00001", clipId: "clip16", word: "mine", start: 5, end: 5.5, isFiller: false },
    ];

    const input = sceneSummaryInput(scene, words, []);
    assert.equal(input.transcript, "mine");
    assert.equal(input.transcript.includes("other"), false);
  });

  it("sceneSummaryInput scopes words by wordId prefix without word.clipId", () => {
    const scene = {
      sceneId: "clip16_scene001",
      clipId: "clip16",
      startSec: 0,
      endSec: 100,
      durationSec: 100,
    };
    const words = [
      { wordId: "clip01_w00001", word: "other", start: 5, end: 5.5, isFiller: false },
      { wordId: "clip16_w00001", word: "mine", start: 5, end: 5.5, isFiller: false },
    ];

    const input = sceneSummaryInput(scene, words, []);
    assert.equal(input.transcript, "mine");
  });

  it("chunkTimelineForL2 keeps contiguous global spans on single-clip continuous timeline", () => {
    const scenes = [];
    for (let i = 0; i < 12; i += 1) {
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
    assert.equal(segments[0].startSec, 0);
    for (let i = 1; i < segments.length; i += 1) {
      assert.equal(segments[i].startSec, segments[i - 1].endSec);
    }
    assert.equal(segments.at(-1).endSec, 720);
  });
});
