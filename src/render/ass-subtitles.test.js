import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateAssSubtitles } from "./ass-subtitles.js";
import { buildRenderEdl } from "./build-render-edl.js";
import { resolveRenderContext } from "./resolve-render-context.js";
import {
  loadFixtureArtifact,
  copyFixtureToWorkDir,
  cleanupWorkDir,
} from "../test-helpers/fixture-work-dir.js";
import { seedClipSourceFiles } from "../test-helpers/seed-clip-sources.js";

const stylePresets = {
  subtitles: {
    default: {
      fontFamily: "Arial",
      fontSizePx: 42,
      color: "#FFF",
      outlineColor: "#000",
      safeMarginPct: 0.08,
    },
  },
};

function withContext(fn) {
  const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-ass" });
  try {
    seedClipSourceFiles(workDir);
    const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
    const context = resolveRenderContext(workDir, recipe);
    return fn(context, recipe);
  } finally {
    cleanupWorkDir(workDir);
  }
}

describe("ass-subtitles", () => {
  it("generates ASS with Dialogue events for word policy", () => {
    withContext((context, recipe) => {
      const output = {
        outputId: "test_subs",
        format: "16:9",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
          audioPolicy: "from_video_ref",
          subtitles: { policy: "word_by_word", sourceClipId: "clip01" },
        }],
      };

      const edl = buildRenderEdl(output, recipe, context);
      const ass = generateAssSubtitles({ edl, context, stylePresets, format: "16:9" });

      assert.match(ass, /\[Script Info\]/);
      assert.match(ass, /Dialogue:/);
    });
  });

  it("clips subtitle events to subtitles.outputStartSec/outputEndSec", () => {
    withContext((context, recipe) => {
      const output = {
        outputId: "test_clip",
        format: "16:9",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
          audioPolicy: "from_video_ref",
          subtitles: {
            policy: "phrase",
            sourceClipId: "clip01",
            outputStartSec: 2,
            outputEndSec: 5,
          },
        }],
      };

      const edl = buildRenderEdl(output, recipe, context);
      const ass = generateAssSubtitles({ edl, context, stylePresets, format: "16:9" });
      const dialogue = ass.split("\n").find((line) => line.startsWith("Dialogue:"));

      assert.ok(dialogue);
      assert.match(dialogue, /,0:00:0[2-5]\./);
    });
  });

  it("generates ASS from golden short_9x16 with fixture word content", () => {
    withContext((context, recipe) => {
      const output = recipe.outputs.find((o) => o.outputId === "short_9x16");
      assert.ok(output, "golden recipe must include short_9x16");

      const wordsFixture = loadFixtureArtifact("mini-day", "01-words-clip01.json");
      const sampleWord = wordsFixture.words.find((w) => w.word === "restauracji")?.word ?? "restauracji";

      const edl = buildRenderEdl(output, recipe, context);
      const ass = generateAssSubtitles({ edl, context, stylePresets, format: "9:16" });
      const dialogueLines = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));

      assert.ok(dialogueLines.length > 0, "expected at least one Dialogue line");
      assert.ok(
        dialogueLines.some((line) => line.includes(sampleWord)),
        `expected a Dialogue line containing "${sampleWord}"`,
      );
    });
  });

  it("uses previous segment outputStartSec for J-cut from_prev subtitles", () => {
    withContext((context, recipe) => {
      const output = {
        outputId: "test_jcut",
        format: "16:9",
        timeline: [
          {
            segmentId: "seg1",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 10,
            audioInSec: 0,
            audioOutSec: 10,
            audioPolicy: "from_video_ref",
            outputStartSec: 0,
            outputEndSec: 12,
          },
          {
            segmentId: "seg2",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 10,
            videoOutSec: 20,
            audioInSec: 0,
            audioOutSec: 10,
            audioPolicy: "from_prev",
            overlapSec: 2,
            subtitles: { policy: "phrase", sourceClipId: "clip01" },
            outputStartSec: 10,
            outputEndSec: 20,
          },
        ],
      };

      const edl = buildRenderEdl(output, recipe, context);
      const ass = generateAssSubtitles({ edl, context, stylePresets, format: "16:9" });
      const dialogue = ass.split("\n").find((line) => line.startsWith("Dialogue:"));

      assert.ok(dialogue);
      assert.match(dialogue, /,0:00:0[0-2]\./);
    });
  });

  it("uses next segment outputStartSec for L-cut from_next subtitles", () => {
    withContext((context, recipe) => {
      const output = {
        outputId: "test_lcut",
        format: "16:9",
        timeline: [
          {
            segmentId: "seg1",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 10,
            audioInSec: 0,
            audioOutSec: 10,
            audioPolicy: "from_next",
            overlapSec: 2,
            subtitles: { policy: "phrase", sourceClipId: "clip01" },
            outputStartSec: 0,
            outputEndSec: 10,
          },
          {
            segmentId: "seg2",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 10,
            videoOutSec: 20,
            audioInSec: 0,
            audioOutSec: 10,
            audioPolicy: "from_video_ref",
            outputStartSec: 8,
            outputEndSec: 18,
          },
        ],
      };

      const edl = buildRenderEdl(output, recipe, context);
      const ass = generateAssSubtitles({ edl, context, stylePresets, format: "16:9" });
      const dialogue = ass.split("\n").find((line) => line.startsWith("Dialogue:"));

      assert.ok(dialogue);
      assert.match(dialogue, /,0:00:1[0-2]\./);
    });
  });
});
