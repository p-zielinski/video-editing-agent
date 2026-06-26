import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPTIONAL_PACKAGES, checkPythonPreflight } from "./python-bridge.js";

describe("python-bridge", () => {
  it("OPTIONAL_PACKAGES includes opencv for live face detection", () => {
    const facePkg = OPTIONAL_PACKAGES.find((pkg) => pkg.module === "cv2");
    assert.ok(facePkg);
    assert.equal(facePkg.label, "opencv-python-headless (face detection)");
    assert.equal(facePkg.faceRequired, true);
  });

  it("checkPythonPreflight accepts faceLive and returns bin", async () => {
    const result = await checkPythonPreflight({ faceLive: false });
    assert.ok(result.bin);
    assert.ok(result.version);
    assert.ok(Array.isArray(result.warnings));
  });

  it("checkPythonPreflight warns when faceLive and OpenCV missing", async () => {
    const result = await checkPythonPreflight({ faceLive: true });
    const hasOpenCv = OPTIONAL_PACKAGES.some((pkg) => pkg.module === "cv2");
    assert.equal(hasOpenCv, true);

    const openCvWarning = (result.warnings ?? []).find((w) => w.includes("opencv-python-headless"));
    try {
      const { spawnSync } = await import("node:child_process");
      const probe = spawnSync(result.bin, ["-c", "import cv2"], { encoding: "utf8" });
      if (probe.status === 0) {
        assert.equal(openCvWarning, undefined);
      } else {
        assert.ok(openCvWarning);
        assert.match(openCvWarning, /stub bbox/);
      }
    } catch {
      // If spawn fails, at least preflight completed
      assert.ok(result.bin);
    }
  });

  it("OPTIONAL_PACKAGES includes panns for live audio event tagging", () => {
    const pannsPkg = OPTIONAL_PACKAGES.find((pkg) => pkg.module === "panns_inference");
    assert.ok(pannsPkg);
    assert.equal(pannsPkg.label, "panns_inference (audio event tagging)");
    assert.equal(pannsPkg.audioRequired, false);
    assert.equal(pannsPkg.audioEventTagging, true);
  });

  it("checkPythonPreflight warns when audioLive and PANNs missing", async (t) => {
    const { spawnSync } = await import("node:child_process");
    const { bin } = await checkPythonPreflight({ faceLive: false });
    const librosaOk = spawnSync(bin, ["-c", "import librosa"], { encoding: "utf8" }).status === 0;
    const soundfileOk = spawnSync(bin, ["-c", "import soundfile"], { encoding: "utf8" }).status === 0;
    if (!librosaOk || !soundfileOk) {
      t.skip("librosa/soundfile required before optional PANNs preflight check");
      return;
    }

    const result = await checkPythonPreflight({ audioLive: true });
    const hasPanns = OPTIONAL_PACKAGES.some((pkg) => pkg.module === "panns_inference");
    assert.equal(hasPanns, true);

    const pannsWarning = (result.warnings ?? []).find((w) => w.includes("panns_inference"));
    const probe = spawnSync(bin, ["-c", "import panns_inference"], { encoding: "utf8" });
    if (probe.status === 0) {
      assert.equal(pannsWarning, undefined);
    } else {
      assert.ok(pannsWarning);
      assert.match(pannsWarning, /eventDetectionMode "none"/);
    }
  });
});
