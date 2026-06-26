import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadFixtureArtifact } from "../../src/test-helpers/fixture-work-dir.js";
import {
  buildBrollSyncHints,
  buildKeyframesByClip,
} from "../../src/editorial/broll-sync-hints.js";

describe("broll-sync-hints", () => {
  const topicIndex = loadFixtureArtifact("mini-day", "05b-topic-index.json");
  const timelineIndex = loadFixtureArtifact("mini-day", "05-timeline-index.json");
  const abstraction = loadFixtureArtifact("mini-day", "06-abstract.json");
  const keyframesClip01 = loadFixtureArtifact("mini-day", "02-keyframes-clip01.json");
  const keyframesClip02 = loadFixtureArtifact("mini-day", "02-keyframes-clip02.json");

  it("buildKeyframesByClip groups timeline keyframes by clipId", () => {
    const byClip = buildKeyframesByClip(timelineIndex);
    assert.equal(byClip.clip02.length, 2);
    assert.equal(byClip.clip02[0].sceneId, "clip02_scene001");
    assert.equal(byClip.clip01, undefined);
  });

  it("buildKeyframesByClip accepts per-clip artifact payloads", () => {
    const byClip = buildKeyframesByClip(timelineIndex, [keyframesClip01, keyframesClip02]);
    assert.equal(byClip.clip01.length, 5);
    assert.equal(byClip.clip02.length, 2);
  });

  it("suggests video ranges for topic matching scenes from keyframes", () => {
    const keyframesByClip = buildKeyframesByClip(timelineIndex, [keyframesClip01, keyframesClip02]);
    const hints = buildBrollSyncHints({
      topicIndex,
      timelineIndex,
      keyframesByClip,
      abstractL1: abstraction.L1,
    });

    assert.ok(hints.length >= 3);
    const restauracjaHint = hints.find((hint) => hint.topicId === "topic_003");
    assert.ok(restauracjaHint);
    assert.equal(restauracjaHint.sceneId, "clip02_scene001");
    assert.ok(restauracjaHint.suggestedVideoInSec >= 0);
    assert.ok(restauracjaHint.suggestedVideoOutSec > restauracjaHint.suggestedVideoInSec);
    assert.ok(restauracjaHint.confidence > 0);
    assert.match(restauracjaHint.reason, /^keyframes:/);
  });

  it("sorts hints by confidence descending", () => {
    const hints = buildBrollSyncHints({
      topicIndex,
      timelineIndex,
      keyframesByClip: buildKeyframesByClip(timelineIndex),
      abstractL1: abstraction.L1,
    });

    for (let i = 1; i < hints.length; i += 1) {
      assert.ok(hints[i - 1].confidence >= hints[i].confidence);
    }
  });

  it("falls back to L1 keyMoments when scene has no keyframes", () => {
    const hints = buildBrollSyncHints({
      topicIndex,
      timelineIndex,
      keyframesByClip: { clip01: keyframesClip01.keyframes, clip02: [] },
      abstractL1: abstraction.L1,
    });

    const brollHints = hints.filter((hint) => hint.sceneId === "clip02_scene001");
    assert.ok(brollHints.length > 0);
    assert.ok(brollHints.every((hint) => hint.reason.startsWith("l1_keyMoment:")));
  });
});
