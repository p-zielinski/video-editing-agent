import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeFromPass,
  shouldRunPass,
  resolveResumeStart,
  PASS_FILES,
} from "./render-resume.js";
import { segmentTempPath } from "./ffmpeg-segment.js";

describe("render-resume", () => {
  it("normalizeFromPass defaults to segments", () => {
    assert.equal(normalizeFromPass(), "segments");
    assert.equal(normalizeFromPass("segments"), "segments");
  });

  it("shouldRunPass runs from named pass onward", () => {
    assert.equal(shouldRunPass("concat", "concat"), true);
    assert.equal(shouldRunPass("concat", "segments"), false);
    assert.equal(shouldRunPass("creative", "concat"), false);
    assert.equal(shouldRunPass("creative", "creative"), true);
    assert.equal(shouldRunPass("creative", "subs"), true);
  });

  it("resolveResumeStart requires segment files for concat resume", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-resume-"));
    try {
      fs.writeFileSync(segmentTempPath(tmpDir, 0), "");
      assert.throws(
        () => resolveResumeStart(tmpDir, "concat", 2),
        /Brak.*seg_001/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolveResumeStart returns concat input for creative resume", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-resume-"));
    try {
      const concatPath = path.join(tmpDir, PASS_FILES.concat);
      fs.writeFileSync(concatPath, "");
      const resume = resolveResumeStart(tmpDir, "creative", 1);
      assert.equal(resume.runSegments, false);
      assert.equal(resume.currentPath, concatPath);
      assert.equal(resume.resumedFromPass, "creative");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
