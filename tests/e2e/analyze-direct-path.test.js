import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COMMAND_DEFAULTS, parseArgs } from "../../src/cli.js";
import {
  copyFixtureToWorkDir,
  cleanupWorkDir,
  loadFixtureArtifact,
} from "../../src/test-helpers/fixture-work-dir.js";
import { ensureClipRegistry } from "../../src/pipeline/steps/clip-profile.js";
import { ClipRegistryArtifactSchema } from "../../src/schemas/edit-recipe-v2.js";
import { ARTIFACTS } from "../../src/pipeline/work-paths.js";

const FIXTURE_EXCLUDE = [
  "05a-clip-registry.json",
  "05b-topic-index.json",
  "05c-spatial-index.json",
  "expected-recipe-v2.json",
  "expected-validation.json",
  "README.md",
];

const workDirs = [];

afterEach(() => {
  while (workDirs.length > 0) {
    cleanupWorkDir(workDirs.pop());
  }
});

function trackWorkDir(workDir) {
  workDirs.push(workDir);
  return workDir;
}

function summarizeClipRegistry(artifact) {
  return (artifact.clipRegistry ?? artifact).map((entry) => ({
    clipId: entry.clipId,
    clipRole: entry.clipRole,
    hasSpeech: entry.hasSpeech,
  }));
}

describe("analyze / direct path E2E — mini-day", () => {
  it("COMMAND_DEFAULTS: analyze ends at clip_profile, direct starts at abstract", () => {
    assert.deepEqual(COMMAND_DEFAULTS.analyze, {
      fromStep: "ingest",
      toStep: "clip_profile",
    });
    assert.deepEqual(COMMAND_DEFAULTS.direct, {
      fromStep: "abstract",
      toStep: "review",
    });

    const analyzeArgs = parseArgs(["node", "cli.js", "analyze", "--input", "./inbox"]);
    assert.equal(analyzeArgs.toStep, "clip_profile");
    assert.equal(analyzeArgs.fromStep, "ingest");

    const directArgs = parseArgs(["node", "cli.js", "direct", "--batch-id", "miniday1"]);
    assert.equal(directArgs.fromStep, "abstract");
    assert.equal(directArgs.toStep, "review");
  });

  it("ensureClipRegistry builds clip registry when artifact is missing", async () => {
    const workDir = trackWorkDir(copyFixtureToWorkDir("mini-day", { exclude: FIXTURE_EXCLUDE }));
    const registryPath = path.join(workDir, ARTIFACTS.clipRegistry);

    assert.equal(fs.existsSync(registryPath), false);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.timelineIndex)), true);

    const goldenClip = loadFixtureArtifact("mini-day", "05a-clip-registry.json");
    const clipRegistry = await ensureClipRegistry(workDir);

    assert.equal(fs.existsSync(registryPath), true);
    ClipRegistryArtifactSchema.parse(clipRegistry);
    assert.deepEqual(
      summarizeClipRegistry(clipRegistry),
      summarizeClipRegistry(goldenClip),
    );
  });

  it("ensureClipRegistry returns existing artifact without rebuild", async () => {
    const workDir = trackWorkDir(copyFixtureToWorkDir("mini-day", { exclude: FIXTURE_EXCLUDE }));
    const goldenClip = loadFixtureArtifact("mini-day", "05a-clip-registry.json");

    const built = await ensureClipRegistry(workDir);
    const mtimeAfterBuild = fs.statSync(path.join(workDir, ARTIFACTS.clipRegistry)).mtimeMs;

    const loaded = await ensureClipRegistry(workDir);

    assert.deepEqual(
      summarizeClipRegistry(loaded),
      summarizeClipRegistry(built),
    );
    assert.deepEqual(
      summarizeClipRegistry(loaded),
      summarizeClipRegistry(goldenClip),
    );
    assert.equal(
      fs.statSync(path.join(workDir, ARTIFACTS.clipRegistry)).mtimeMs,
      mtimeAfterBuild,
    );
  });
});
