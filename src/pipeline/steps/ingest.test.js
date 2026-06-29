import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMediaType,
  isAudioFile,
  scanInputFolder,
} from "./ingest.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WHOOSH = path.join(ROOT, "assets/sfx/whoosh.wav");

describe("ingest", () => {
  it("scanInputFolder picks up .wav files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-ingest-"));
    const wavName = "03_narration.wav";
    fs.copyFileSync(WHOOSH, path.join(dir, wavName));

    const clips = await scanInputFolder(dir);
    assert.equal(clips.length, 1);
    assert.equal(clips[0].fileName, wavName);
    assert.equal(isAudioFile(wavName), true);
    assert.equal(getMediaType(wavName), "audio_only");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
