import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runAudioAnalysisStep } from "./audio-analysis.js";
import { ClipAudioAnalysisSchema, AudioIndexSchema } from "../../schemas/audio-analysis.js";
import { summarizeMusicLibraryForIndex } from "../../editorial/music-library.js";
import { ARTIFACTS, writeJson, readJson } from "../work-paths.js";
import { runPythonScript } from "../../lib/python-bridge.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PYTHON_DIR = path.join(ROOT, "python");

function runFfmpegAstatsAnalysisMock(durationSec = 4) {
  const script = `
import json
from unittest.mock import patch, MagicMock
import sys
sys.path.insert(0, ${JSON.stringify(PYTHON_DIR)})
from audio_analyze import analyze_with_ffmpeg

stderr = "\\n".join([
  "RMS level dB: -50.0",
  "RMS level dB: -50.0",
  "RMS level dB: -20.0",
  "RMS level dB: -20.0",
  "RMS level dB: -50.0",
  "RMS level dB: -50.0",
])

fake_proc = MagicMock()
fake_proc.stderr = stderr
fake_proc.returncode = 0

with patch("subprocess.run", return_value=fake_proc):
    result = analyze_with_ffmpeg("/tmp/fake.wav", ${durationSec})

print(json.dumps(result))
`;

  const proc = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return JSON.parse(proc.stdout);
}

describe("audio_analyze.py", () => {
  it("stub mode returns synthetic beats for fixture-style analysis", async () => {
    const result = await runPythonScript("audio_analyze.py", {
      stub: true,
      durationSec: 60,
    });

    assert.equal(result.analysisMode, "stub");
    assert.ok(result.beats.length > 0);
    assert.equal(result.estimatedBpm, 120);
    assert.ok(result.cutSuggestions.some((cut) => cut.reason === "onset"));
  });

  it("ffmpeg astats path has no beats and only silence cut suggestions", () => {
    const result = runFfmpegAstatsAnalysisMock(4);

    assert.equal(result.analysisMode, "ffmpeg_astats");
    assert.deepEqual(result.beats, []);
    assert.equal(result.estimatedBpm, null);
    assert.ok(result.energyCurve.length > 0);
    assert.ok(result.silenceGaps.length > 0);
    assert.ok(result.cutSuggestions.length <= 8);
    assert.ok(result.cutSuggestions.every((cut) => cut.reason === "silence_start"));
    assert.equal(result.cutSuggestions.length, result.silenceGaps.length);
  });
});

describe("audio-analysis step", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-audio-step-"));
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      version: "1.0",
      batchId: "audio-test",
      clips: [
        {
          clipId: "clip01",
          sourcePath: "/nonexistent/clip01.mp4",
          durationSec: 60,
        },
      ],
      scenes: [],
    });
    writeJson(path.join(workDir, ARTIFACTS.words("clip01")), {
      version: "1.0",
      clipId: "clip01",
      words: [],
      durationSec: 60,
    });
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("writes per-clip 01b and batch 05d in stub mode", async () => {
    const index = await runAudioAnalysisStep({ workDir, stub: true, force: true });
    AudioIndexSchema.parse(index);

    const clipPath = path.join(workDir, ARTIFACTS.audioAnalysis("clip01"));
    assert.equal(fs.existsSync(clipPath), true);
    const clipAnalysis = ClipAudioAnalysisSchema.parse(readJson(clipPath));
    assert.ok(clipAnalysis.audioEvents.length >= 1);
    assert.ok(clipAnalysis.editorialTags.length >= 1);
    assert.equal(clipAnalysis.eventDetectionMode, "stub");

    assert.equal(index.clips.length, 1);
    assert.equal(index.clips[0].eventDetectionMode, "stub");
    assert.equal(index.batchSummary.eventDetectionMode, "stub");
    assert.ok(index.clips[0].editorialTags.length >= 1);
    assert.ok(index.batchSummary.clipCount === 1);
    assert.ok(index.musicLibrary);
    assert.equal(index.musicLibrary.trackCount, summarizeMusicLibraryForIndex().trackCount);
  });
});
