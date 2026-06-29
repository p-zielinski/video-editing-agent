import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isFfmpegAvailable } from "../../src/render/execute-render.js";
import { probeDuration } from "../../src/lib/ffmpeg.js";
import { resolveFfmpegBins } from "../../src/lib/ffmpeg-bin.js";
import {
  cleanupWorkDir,
  copyFixtureToWorkDir,
  loadFixtureArtifact,
} from "../../src/test-helpers/fixture-work-dir.js";
import { writeJson, ARTIFACTS, readJson } from "../../src/pipeline/work-paths.js";
import { buildRenderEdl } from "../../src/render/build-render-edl.js";
import { resolveRenderContext } from "../../src/render/resolve-render-context.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.js");

const workDirs = [];

afterEach(() => {
  while (workDirs.length > 0) {
    cleanupWorkDir(workDirs.pop());
  }
});

function createLavfiMp4(targetPath, { width = 320, height = 240, duration = 3 } = {}) {
  const { ffmpeg } = resolveFfmpegBins();
  const result = spawnSync(
    ffmpeg,
    [
      "-y",
      "-f", "lavfi",
      "-i", `color=c=blue:s=${width}x${height}:d=${duration}`,
      "-f", "lavfi",
      "-i", `sine=frequency=440:duration=${duration}`,
      "-t", String(duration),
      "-c:v", "libx264",
      "-c:a", "aac",
      "-shortest",
      targetPath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

function setupMiniDayRenderWorkDir(prefix) {
  const workDir = copyFixtureToWorkDir("mini-day", { prefix });
  workDirs.push(workDir);

  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-inbox-`));
  workDirs.push(inboxDir);

  createLavfiMp4(path.join(inboxDir, "01_talk.MOV"), { width: 1920, height: 1080, duration: 120 });
  createLavfiMp4(path.join(inboxDir, "02_broll.MOV"), { width: 1920, height: 1080, duration: 45 });

  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  catalog.clips[0].sourcePath = path.join(inboxDir, "01_talk.MOV");
  catalog.clips[1].sourcePath = path.join(inboxDir, "02_broll.MOV");
  writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), catalog);

  const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
  writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

  return { workDir, recipe };
}

function expectedEdlDuration(recipe, workDir) {
  const context = resolveRenderContext(workDir, recipe);
  const output = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
  return buildRenderEdl(output, recipe, context).durationSec;
}

describe("render CLI E2E", () => {
  it("renders horizontal_main via node src/cli.js render", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupMiniDayRenderWorkDir("vea-render-cli");
    const expectedDuration = expectedEdlDuration(recipe, workDir);

    const result = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "render",
        "--batch-id", recipe.batchId,
        "--output-dir", workDir,
        "--output-id", "horizontal_main",
        "--encode-profile", "draft",
        "--force",
      ],
      { encoding: "utf8", cwd: REPO_ROOT },
    );

    assert.equal(
      result.status,
      0,
      `CLI failed (status ${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
    assert.ok(result.stdout.includes("Wyrenderowano:"));

    const manifestPath = path.join(workDir, ARTIFACTS.renderManifest);
    assert.equal(fs.existsSync(manifestPath), true);

    const manifest = readJson(manifestPath);
    const entry = manifest.outputs.find((o) => o.outputId === "horizontal_main");
    assert.ok(entry?.outputPath);
    assert.equal(fs.existsSync(entry.outputPath), true);
    assert.equal(entry.warnings?.some((w) => w.fatal) ?? false, false);

    const duration = await probeDuration(entry.outputPath);
    assert.ok(
      Math.abs(duration - expectedDuration) <= 1,
      `expected ~${expectedDuration}s, got ${duration}s`,
    );
  });

  it("renders all outputs via CLI without --output-id", async (t) => {
    if (!isFfmpegAvailable()) {
      t.skip("ffmpeg not available");
    }

    const { workDir, recipe } = setupMiniDayRenderWorkDir("vea-render-cli-all");

    const result = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "render",
        "--batch-id", recipe.batchId,
        "--output-dir", workDir,
        "--encode-profile", "draft",
        "--force",
      ],
      { encoding: "utf8", cwd: REPO_ROOT },
    );

    assert.equal(
      result.status,
      0,
      `CLI failed (status ${result.status}):\n${result.stderr}\n${result.stdout}`,
    );

    const manifestPath = path.join(workDir, ARTIFACTS.renderManifest);
    assert.equal(fs.existsSync(manifestPath), true);

    const manifest = readJson(manifestPath);
    assert.equal(manifest.outputs.length, 2);

    for (const outputId of ["horizontal_main", "short_9x16"]) {
      const entry = manifest.outputs.find((o) => o.outputId === outputId);
      assert.ok(entry?.outputPath, `missing render for ${outputId}`);
      assert.equal(fs.existsSync(entry.outputPath), true);
      assert.equal(entry.skipped, false);
    }
  });
});
