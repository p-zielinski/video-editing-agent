import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  copyFixtureToWorkDir,
  cleanupWorkDir,
  loadFixtureArtifact,
} from "../../test-helpers/fixture-work-dir.js";
import { runRecipeEnrichStep } from "./recipe-enrich.js";
import { ARTIFACTS, readJson, writeJson } from "../work-paths.js";

const workDirs = [];

afterEach(() => {
  while (workDirs.length > 0) {
    cleanupWorkDir(workDirs.pop());
  }
});

describe("runRecipeEnrichStep", () => {
  it("re-enriches draft recipe idempotently without GPT", async () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-re-enrich" });
    workDirs.push(workDir);

    const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
    writeJson(path.join(workDir, ARTIFACTS.recipeDraft), recipe);

    const first = await runRecipeEnrichStep({
      workDir,
      source: "draft",
      target: "draft",
      force: true,
      faceStub: true,
    });

    const second = await runRecipeEnrichStep({
      workDir,
      source: "draft",
      target: "draft",
      force: true,
      faceStub: true,
    });

    assert.equal(first.validation.valid, true);
    assert.equal(second.validation.valid, true);
    assert.equal(
      first.recipe.outputs[0].timeline.length,
      second.recipe.outputs[0].timeline.length,
    );
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.recipeDraft)), true);
  });
});
