import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enhancementInputAudioPath,
  extractAudioForEnhancement,
  alignAudioDuration,
  ENHANCEMENT_DURATION_ALIGN_TOLERANCE_SEC,
} from "./extract-audio.js";
import { probeDuration, runFfmpeg } from "./ffmpeg.js";

describe("extract-audio enhancement helpers", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-extract-enh-"));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("extractAudioForEnhancement writes 48 kHz mono PCM", async () => {
    const sourcePath = path.join(workDir, "src.wav");
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=mono",
      "-t",
      "0.3",
      "-acodec",
      "pcm_s16le",
      sourcePath,
    ], { label: "test src" });

    const outPath = enhancementInputAudioPath(workDir, "clip01");
    await extractAudioForEnhancement(sourcePath, outPath);
    assert.ok(fs.existsSync(outPath));
    assert.ok(fs.statSync(outPath).size > 100);
  });

  it("alignAudioDuration pads shorter audio to target", async () => {
    const shortPath = path.join(workDir, "short.wav");
    const alignedPath = path.join(workDir, "aligned.wav");
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono",
      "-t",
      "0.2",
      "-acodec",
      "pcm_s16le",
      shortPath,
    ], { label: "short wav" });

    const result = await alignAudioDuration(shortPath, alignedPath, 0.5);
    assert.equal(result.aligned, true);
    assert.ok(result.durationDeltaMs < 0);
    const duration = await probeDuration(alignedPath);
    assert.ok(Math.abs(duration - 0.5) <= ENHANCEMENT_DURATION_ALIGN_TOLERANCE_SEC + 0.05);
  });
});
