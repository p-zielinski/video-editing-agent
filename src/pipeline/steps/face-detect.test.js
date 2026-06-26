import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectFaceDetections } from "./face-detect.js";
import { ARTIFACTS, writeJson } from "../work-paths.js";

describe("face_detect", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-face-detect-"));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("collectFaceDetections merges per-clip face artifacts", () => {
    writeJson(path.join(workDir, ARTIFACTS.faces("clip01")), {
      version: "1.0",
      clipId: "clip01",
      detections: [
        {
          type: "face",
          sceneId: "clip01_scene001",
          label: "face",
          confidence: 0.6,
          timestampSec: 2,
          bbox: [0.35, 0.05, 0.3, 0.25],
        },
      ],
    });
    writeJson(path.join(workDir, ARTIFACTS.faces("clip02")), {
      version: "1.0",
      clipId: "clip02",
      detections: [
        {
          type: "face",
          sceneId: "clip02_scene001",
          label: "face",
          confidence: 0.55,
          timestampSec: 1,
          bbox: [0.35, 0.05, 0.3, 0.25],
        },
      ],
    });

    const catalog = {
      clips: [{ clipId: "clip01" }, { clipId: "clip02" }],
    };

    const detections = collectFaceDetections(workDir, catalog);
    assert.equal(detections.length, 2);
    assert.equal(detections[0].type, "face");
    assert.equal(detections[1].sceneId, "clip02_scene001");
  });

  it("collectFaceDetections tolerates missing artifacts", () => {
    const catalog = { clips: [{ clipId: "missing" }] };
    assert.deepEqual(collectFaceDetections(workDir, catalog), []);
  });
});
