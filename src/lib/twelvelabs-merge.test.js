import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadTwelveLabsByClip,
  mergeTwelveLabsIntoVisualText,
} from "./twelvelabs-merge.js";
import { ARTIFACTS, writeJson } from "../pipeline/work-paths.js";

describe("twelvelabs-merge", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-tl-merge-"));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("loadTwelveLabsByClip returns null when artifact is missing", () => {
    assert.equal(loadTwelveLabsByClip(workDir, "clip01"), null);
  });

  it("loadTwelveLabsByClip reads artifact from workDir", () => {
    const payload = {
      version: "1.0",
      clipId: "clip01",
      indexingStatus: "stub",
      chapters: [],
      moments: [{ startSec: 2, endSec: 8, description: "chef plating pasta" }],
    };
    writeJson(path.join(workDir, ARTIFACTS.twelvelabs("clip01")), payload);

    const loaded = loadTwelveLabsByClip(workDir, "clip01");
    assert.deepEqual(loaded, payload);
  });

  it("mergeTwelveLabsIntoVisualText combines qwen captions with overlapping moments", () => {
    const scene = { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 30 };
    const qwenCaptions = [
      { sceneId: "clip02_scene001", caption: "wide shot of kitchen", tags: ["cooking"] },
    ];
    const tlMoments = [
      { startSec: 5, endSec: 12, description: "close-up of pasta", tags: ["food"] },
      { startSec: 40, endSec: 50, description: "outro shot" },
    ];

    const merged = mergeTwelveLabsIntoVisualText(qwenCaptions, tlMoments, scene);

    assert.match(merged, /wide shot of kitchen/);
    assert.match(merged, /cooking/);
    assert.match(merged, /close-up of pasta/);
    assert.match(merged, /food/);
    assert.doesNotMatch(merged, /outro shot/);
  });

  it("mergeTwelveLabsIntoVisualText returns empty string when no inputs", () => {
    const scene = { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 30 };
    assert.equal(mergeTwelveLabsIntoVisualText([], [], scene), "");
  });
});
