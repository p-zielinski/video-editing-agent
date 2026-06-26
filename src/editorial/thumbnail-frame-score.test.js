import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreFrameForThumbnail, shortlistThumbnailFrames } from "./thumbnail-frame-score.js";
import { loadFixtureArtifact } from "../test-helpers/fixture-work-dir.js";

const timelineIndex = loadFixtureArtifact("mini-day", "05-timeline-index.json");
const abstraction = loadFixtureArtifact("mini-day", "06-abstract.json");
const spatialIndex = loadFixtureArtifact("mini-day", "05c-spatial-index.json");
const audioIndex = loadFixtureArtifact("mini-day", "05d-audio-index.json");
const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");

describe("thumbnail-frame-score", () => {
  it("scores hook scene with face higher than low-quality b-roll", () => {
    const hookScene = timelineIndex.scenes.find((s) => s.sceneId === "clip01_scene001");
    const brollScene = timelineIndex.scenes.find((s) => s.sceneId === "clip02_scene001");
    const hookL1 = abstraction.L1.find((entry) => entry.sceneId === "clip01_scene001");
    const brollL1 = abstraction.L1.find((entry) => entry.sceneId === "clip02_scene001");
    const hookAnchor = spatialIndex.scenes
      .find((s) => s.sceneId === "clip01_scene001")
      ?.anchors.find((a) => a.type === "face");

    const hookScore = scoreFrameForThumbnail({
      scene: hookScene,
      l1: hookL1,
      spatialAnchor: hookAnchor,
      isHookScene: true,
      timelineIndex,
    });
    const brollScore = scoreFrameForThumbnail({
      scene: brollScene,
      l1: brollL1,
      isHookScene: false,
      timelineIndex,
    });

    assert.ok(hookScore > brollScore);
    assert.ok(hookScore <= 1);
    assert.ok(brollScore >= 0);
  });

  it("shortlists candidates for each output from mini-day recipe", () => {
    for (const output of recipe.outputs) {
      const shortlist = shortlistThumbnailFrames({
        recipe,
        timelineIndex,
        abstraction,
        spatialIndex,
        audioIndex,
        outputId: output.outputId,
        maxCandidates: 5,
      });

      assert.ok(shortlist.length >= 1);
      assert.ok(shortlist.length <= 5);
      assert.equal(typeof shortlist[0].score, "number");
      assert.equal(typeof shortlist[0].hasFace, "boolean");
      assert.ok(shortlist[0].sceneId);
      if (shortlist[0].hasFace) {
        assert.ok(Array.isArray(shortlist[0].faceBbox));
      }
    }
  });

  it("returns unique scene/timestamp pairs sorted by score", () => {
    const shortlist = shortlistThumbnailFrames({
      recipe,
      timelineIndex,
      abstraction,
      spatialIndex,
      audioIndex,
      outputId: "horizontal_main",
      maxCandidates: 10,
    });

    const keys = shortlist.map((entry) => `${entry.sceneId}:${entry.timestampSec}`);
    assert.equal(new Set(keys).size, keys.length);
    for (let i = 1; i < shortlist.length; i += 1) {
      assert.ok(shortlist[i - 1].score >= shortlist[i].score);
    }
  });
});
