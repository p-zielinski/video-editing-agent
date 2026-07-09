#!/usr/bin/env node
/**
 * Generate repo test SFX WAV stubs via ffmpeg lavfi.
 * Reads assets/sfx/catalog.json; skips files that already exist unless --force.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SFX_DIR = path.join(REPO_ROOT, "assets", "sfx");
const CATALOG_PATH = path.join(SFX_DIR, "catalog.json");

/** @type {Record<string, { lavfi: string, sampleRate?: number }>} */
const STUB_RECIPES = {
  whoosh: { lavfi: "sine=frequency=440:duration=0.12", sampleRate: 8000 },
  impact_heavy_01: { lavfi: "sine=frequency=120:duration=0.35", sampleRate: 8000 },
  applause_short_01: { lavfi: "anoisesrc=d=0.8:c=pink:a=0.25", sampleRate: 8000 },
  thunder_rumble_01: { lavfi: "anoisesrc=d=1.2:c=brown:a=0.2", sampleRate: 8000 },
  laughter_short_01: { lavfi: "sine=frequency=880:duration=0.08", sampleRate: 8000 },
  click_short_01: { lavfi: "sine=frequency=2000:duration=0.05", sampleRate: 8000 },
  bleep_censor_01: { lavfi: "sine=frequency=1000:duration=0.12", sampleRate: 8000 },
  riser_short_01: { lavfi: "sine=frequency=200:duration=0.6", sampleRate: 8000 },
  swoosh_fast_01: { lavfi: "sine=frequency=660:duration=0.18", sampleRate: 8000 },
  swoosh_soft_01: { lavfi: "sine=frequency=330:duration=0.35", sampleRate: 8000 },
};

function ffmpegAvailable() {
  const result = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return result.status === 0;
}

function generateStub(fileName, sfxId, { force = false } = {}) {
  const outPath = path.join(SFX_DIR, fileName);
  if (fs.existsSync(outPath) && !force) {
    return { fileName, status: "skipped" };
  }

  const recipe = STUB_RECIPES[sfxId];
  if (!recipe) {
    return { fileName, status: "no_recipe", sfxId };
  }

  const sampleRate = recipe.sampleRate ?? 8000;
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f", "lavfi",
      "-i", recipe.lavfi,
      "-ar", String(sampleRate),
      "-ac", "1",
      outPath,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );

  if (result.status !== 0) {
    throw new Error(`ffmpeg failed for ${fileName}: ${result.stderr}`);
  }

  return { fileName, status: "generated" };
}

function main() {
  const force = process.argv.includes("--force");
  if (!ffmpegAvailable()) {
    console.error("ffmpeg not found — install ffmpeg to generate SFX stubs");
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  const results = [];

  for (const sound of catalog.sounds) {
    results.push(generateStub(sound.fileName, sound.sfxId, { force }));
  }

  const generated = results.filter((r) => r.status === "generated").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const missing = results.filter((r) => r.status === "no_recipe");

  console.log(`SFX stubs: ${generated} generated, ${skipped} skipped`);
  if (missing.length > 0) {
    console.warn("No lavfi recipe for:", missing.map((m) => m.sfxId).join(", "));
  }
}

main();
