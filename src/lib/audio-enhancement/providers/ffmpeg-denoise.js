import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "../../ffmpeg.js";

export async function enhanceWithFfmpegDenoise({
  inputPath,
  outputPath,
  arnndnModelPath = null,
}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const filters = ["highpass=f=80"];
  if (arnndnModelPath && fs.existsSync(arnndnModelPath)) {
    filters.push(`arnndn=m=${arnndnModelPath}`);
  } else {
    filters.push("afftdn=nr=18:nf=-25");
  }

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-af",
    filters.join(","),
    "-ar",
    "48000",
    "-ac",
    "1",
    outputPath,
  ], { label: "ffmpeg denoise (afftdn/arnndn)" });

  return {
    provider: "ffmpeg",
    model: arnndnModelPath ? "arnndn" : "afftdn",
    status: "succeeded",
  };
}
