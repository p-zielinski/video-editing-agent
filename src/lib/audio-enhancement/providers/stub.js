import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "../../ffmpeg.js";

export async function enhanceWithStub({ inputPath, outputPath }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-ar",
    "48000",
    "-ac",
    "1",
    outputPath,
  ], { label: "audio enhancement stub (copy)" });

  return {
    provider: "stub",
    model: "copy",
    status: "stubbed",
  };
}
