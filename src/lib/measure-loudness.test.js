import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { measureLoudness } from "./measure-loudness.js";
import { runFfmpeg } from "./ffmpeg.js";

describe("measure-loudness", () => {
  it("returns integrated LUFS from a generated wav", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vea-loud-"));
    try {
      const wav = path.join(tmp, "tone.wav");
      await runFfmpeg([
        "-y",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=0.5",
        "-acodec", "pcm_s16le",
        wav,
      ], { label: "test tone" });

      const result = await measureLoudness(wav);
      assert.ok(Number.isFinite(result.integratedLufs));
      assert.ok(result.integratedLufs < 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
