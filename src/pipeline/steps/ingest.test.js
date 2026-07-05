import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeSourceContentHash } from "../../lib/source-hash.js";
import {
  getMediaType,
  isAudioFile,
  isManifestSourceContentFresh,
  isManifestInputSetFresh,
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

  it("getMediaType returns audio_only for .mp3 and .m4a", () => {
    assert.equal(getMediaType("narration.mp3"), "audio_only");
    assert.equal(getMediaType("narration.m4a"), "audio_only");
    assert.equal(isAudioFile("narration.mp3"), true);
    assert.equal(isAudioFile("narration.m4a"), true);
  });

  it("isManifestSourceContentFresh detects swapped source files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-ingest-hash-"));
    const filePath = path.join(dir, "clip.mp4");
    fs.writeFileSync(filePath, "version-a");

    const contentHash = await computeSourceContentHash(filePath);
    const manifest = {
      clips: [{ clipId: "clip01", sourcePath: filePath, contentHash }],
    };

    assert.equal(await isManifestSourceContentFresh(manifest), true);

    fs.writeFileSync(filePath, "version-b");
    assert.equal(await isManifestSourceContentFresh(manifest), false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("isManifestSourceContentFresh treats manifests without contentHash as stale", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-ingest-legacy-"));
    const filePath = path.join(dir, "clip.mp4");
    fs.writeFileSync(filePath, "legacy");

    const manifest = {
      clips: [{ clipId: "clip01", sourcePath: filePath }],
    };

    assert.equal(await isManifestSourceContentFresh(manifest), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("isManifestInputSetFresh detects added or removed input files", () => {
    const manifest = {
      clips: [{ fileName: "a.mp4" }, { fileName: "b.mp4" }],
    };
    assert.equal(
      isManifestInputSetFresh(manifest, [{ fileName: "a.mp4" }, { fileName: "b.mp4" }]),
      true,
    );
    assert.equal(
      isManifestInputSetFresh(manifest, [{ fileName: "a.mp4" }]),
      false,
    );
    assert.equal(
      isManifestInputSetFresh(manifest, [{ fileName: "a.mp4" }, { fileName: "c.mp4" }]),
      false,
    );
  });
});
