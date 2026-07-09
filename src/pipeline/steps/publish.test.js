import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  runPublishStep,
  formatChapterTimestamp,
  formatChapterTimestamps,
  assemblePublishDescription,
  resolvePublishTags,
  buildPublishPackageForOutput,
} from "./publish.js";
import { ARTIFACTS, renderOutputPath } from "../work-paths.js";
import {
  cleanupWorkDir,
  copyFixtureToWorkDir,
  loadFixtureArtifact,
} from "../../test-helpers/fixture-work-dir.js";
import { PublishPackageSchema } from "../../schemas/publish-package.js";
import { buildStubThumbnailPlan } from "../../agents/thumbnail-strategist.js";
import { syncOutputChapterMarkers } from "../../editorial/chapter-hints.js";

describe("publish pipeline step", () => {
  let workDir;

  after(() => {
    cleanupWorkDir(workDir);
  });

  it("formats chapter timestamps for YouTube descriptions", () => {
    assert.equal(formatChapterTimestamp(0), "0:00");
    assert.equal(formatChapterTimestamp(65), "1:05");
    assert.equal(formatChapterTimestamp(3661), "1:01:01");
    assert.deepEqual(
      formatChapterTimestamps([
        { title: "Intro", startSec: 0 },
        { title: "Main", startSec: 90 },
      ]),
      ["0:00 Intro", "1:30 Main"],
    );
  });

  it("assembles description from synopsis and chapter timestamps", () => {
    const description = assemblePublishDescription(
      "Vlog o restauracji",
      ["0:00 Intro", "1:30 Main"],
    );
    assert.equal(description, "Vlog o restauracji\n\n0:00 Intro\n1:30 Main");
  });

  it("writes publish packages per output from fixture data", async () => {
    workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-publish-step" });
    const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
    const abstraction = loadFixtureArtifact("mini-day", "06-abstract.json");
    const topicIndex = loadFixtureArtifact("mini-day", "topic-index.json");
    const thumbnailPlan = buildStubThumbnailPlan({ recipe, frameShortlistByOutput: {} });

    fs.writeFileSync(
      path.join(workDir, ARTIFACTS.recipeFinal),
      `${JSON.stringify(recipe, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(workDir, ARTIFACTS.abstraction),
      `${JSON.stringify(abstraction, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(workDir, ARTIFACTS.topicIndex),
      `${JSON.stringify(topicIndex, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(workDir, ARTIFACTS.thumbnailPlan),
      `${JSON.stringify(thumbnailPlan, null, 2)}\n`,
      "utf8",
    );

    const mainVideoPath = renderOutputPath(workDir, "horizontal_main", "16:9");
    fs.mkdirSync(path.dirname(mainVideoPath), { recursive: true });
    fs.writeFileSync(mainVideoPath, "video", "utf8");
    const renderManifest = {
      batchId: recipe.batchId,
      outputs: [{
        outputId: "horizontal_main",
        format: "16:9",
        outputPath: mainVideoPath,
        durationSec: 60,
      }],
    };
    fs.writeFileSync(
      path.join(workDir, ARTIFACTS.renderManifest),
      `${JSON.stringify(renderManifest, null, 2)}\n`,
      "utf8",
    );

    const result = await runPublishStep({ workDir });

    assert.equal(Object.keys(result.packages).length, recipe.outputs.length);

    const mainPackage = PublishPackageSchema.parse(result.packages.horizontal_main);
    assert.equal(mainPackage.title, "Dzień 66 — restauracja");
    assert.equal(mainPackage.titleVariants.length, 3);
    assert.ok(mainPackage.description.includes("vlog o restauracji"));
    assert.ok(mainPackage.tags.includes("restauracji"));
    assert.equal(mainPackage.videoPath, mainVideoPath);
    assert.equal(mainPackage.shortsCaption, null);

    const shortPackage = PublishPackageSchema.parse(result.packages.short_9x16);
    assert.equal(shortPackage.shortsCaption, "");
    assert.equal(shortPackage.videoPath, null);

    assert.equal(
      fs.existsSync(path.join(workDir, ARTIFACTS.publishPackage("horizontal_main"))),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(workDir, ARTIFACTS.publishPackage("short_9x16"))),
      true,
    );
  });

  it("derives chapter markers from timeline overlays when recipe chapterMarkers are empty", () => {
    const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
    const abstraction = loadFixtureArtifact("mini-day", "06-abstract.json");
    const mainOutput = {
      ...recipe.outputs[0],
      chapterMarkers: [],
      timeline: recipe.outputs[0].timeline.map((segment, index) => (
        index === 0
          ? {
            ...segment,
            textOverlays: [{
              overlayId: "chapter_test",
              text: "Intro restauracji",
              outputStartSec: 0,
              outputEndSec: 4,
              style: "chapter_card",
              role: "chapter",
            }],
          }
          : segment
      )),
    };

    const publishPackage = buildPublishPackageForOutput({
      recipe,
      output: mainOutput,
      topicIndex: loadFixtureArtifact("mini-day", "topic-index.json"),
      workDir: "/tmp/unused",
      abstraction,
    });

    assert.deepEqual(publishPackage.chapterTimestamps, ["0:00 Intro restauracji"]);
  });

  it("falls back to L2 chapter targets for long main outputs", () => {
    const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
    const abstraction = loadFixtureArtifact("mini-day", "06-abstract.json");
    const mainOutput = {
      ...recipe.outputs[0],
      chapterMarkers: [],
      targetDurationSec: 300,
    };

    syncOutputChapterMarkers(mainOutput, { abstraction, recipe });

    const publishPackage = buildPublishPackageForOutput({
      recipe: {
        ...recipe,
        outputs: [mainOutput, recipe.outputs[1]],
      },
      output: mainOutput,
      topicIndex: loadFixtureArtifact("mini-day", "topic-index.json"),
      workDir: "/tmp/unused",
      abstraction,
    });

    assert.ok(publishPackage.chapterTimestamps.length > 0);
    assert.match(publishPackage.chapterTimestamps[0], /^\d+:\d{2} /);
  });

  it("resolvePublishTags merges topic index labels", () => {
    const topicIndex = loadFixtureArtifact("mini-day", "topic-index.json");
    const tags = resolvePublishTags({ topicIndex, workDir: "/tmp/missing" });
    assert.ok(tags.includes("restauracji"));
    assert.ok(tags.includes("restauracja"));
  });
});
