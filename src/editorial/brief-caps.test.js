import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DIRECTOR_BRIEF_CAPS,
  DRILL_DOWN_CAPS,
  SEGMENT_BRIEF_CAPS,
  CRITIC_BRIEF_CAPS,
} from "../../src/editorial/brief-caps.js";
import { DIRECTOR_AUDIO_CAPS, DEFAULT_AUDIO_CAPS } from "../../src/editorial/audio-index-summary.js";

describe("brief-caps", () => {
  it("DIRECTOR_BRIEF_CAPS consolidates director editorial limits", () => {
    assert.equal(DIRECTOR_BRIEF_CAPS.maxWordsPerScene, 120);
    assert.equal(DIRECTOR_BRIEF_CAPS.maxWordsPerSceneWhenL1Good, 40);
    assert.equal(DIRECTOR_BRIEF_CAPS.L1_GOOD_COVERAGE_RATIO, 0.7);
    assert.equal(DIRECTOR_BRIEF_CAPS.TECHNIQUE_CATALOG_MAX_CHARS, 4_500);
    assert.equal(DIRECTOR_BRIEF_CAPS.spatialAnchorLimit, 3);
    assert.equal(DIRECTOR_BRIEF_CAPS.includeFullTopicIndex, true);
    assert.deepEqual(DIRECTOR_BRIEF_CAPS.audioCaps, DIRECTOR_AUDIO_CAPS);
    assert.equal(DIRECTOR_BRIEF_CAPS.L1_SUMMARY_MAX_CHARS, 500);
    assert.equal(DIRECTOR_BRIEF_CAPS.VISION_CAPTION_MAX_CHARS, 200);
    assert.equal(DIRECTOR_BRIEF_CAPS.BROLL_SYNC_HINTS_LIMIT, 25);
  });

  it("DRILL_DOWN_CAPS matches DIRECTOR_BRIEF_CAPS (key fix)", () => {
    assert.deepEqual(DRILL_DOWN_CAPS, DIRECTOR_BRIEF_CAPS);
  });

  it("SEGMENT_BRIEF_CAPS matches DIRECTOR_BRIEF_CAPS", () => {
    assert.deepEqual(SEGMENT_BRIEF_CAPS, DIRECTOR_BRIEF_CAPS);
  });

  it("CRITIC_BRIEF_CAPS uses tighter limits", () => {
    assert.equal(CRITIC_BRIEF_CAPS.maxWordsPerScene, 80);
    assert.equal(CRITIC_BRIEF_CAPS.spatialAnchorLimit, 1);
    assert.equal(CRITIC_BRIEF_CAPS.includeFullTopicIndex, false);
    assert.deepEqual(CRITIC_BRIEF_CAPS.audioCaps, DEFAULT_AUDIO_CAPS);
  });
});
