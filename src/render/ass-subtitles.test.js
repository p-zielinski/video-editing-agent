import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateAssSubtitles, buildWordSubtitleEvents, isBoilerplateSubtitleWord, filterSubtitleWords } from "./ass-subtitles.js";
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

  it("uses Top ASS style when subtitles.placement is top", () => {
    withContext((context, recipe) => {
      const output = {
        outputId: "test_placement_top",
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
            placement: "top",
          },
        }],
      };

      const edl = buildRenderEdl(output, recipe, context);
      const ass = generateAssSubtitles({ edl, context, stylePresets, format: "16:9" });

      assert.match(ass, /Style: Top,/);
      assert.match(ass, /Style: Top,.*,-1,8,/);
      const dialogue = ass.split("\n").find((line) => line.startsWith("Dialogue:"));
      assert.ok(dialogue);
      assert.match(dialogue, /,Top,/);
    });
  });

  it("defaults Dialogue style to Bottom when placement unset", () => {
    withContext((context, recipe) => {
      const output = {
        outputId: "test_placement_default",
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
          subtitles: { policy: "phrase", sourceClipId: "clip01" },
        }],
      };

      const edl = buildRenderEdl(output, recipe, context);
      const ass = generateAssSubtitles({ edl, context, stylePresets, format: "16:9" });
      const dialogue = ass.split("\n").find((line) => line.startsWith("Dialogue:"));
      assert.ok(dialogue);
      assert.match(dialogue, /,Bottom,/);
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

  it("censors profane tokens without displayWord in subtitles", () => {
    withContext((context, recipe) => {
      context.wordIndexes.clip01 = {
        clipId: "clip01",
        words: [
          { wordId: "clip01_w001", word: "hej", start: 0.5, end: 0.8, isProfanity: false },
          { wordId: "clip01_w002", word: "kurwa", start: 1.0, end: 1.4, isProfanity: true },
        ],
      };

      const output = {
        outputId: "test_profanity_censor",
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
          outputStartSec: 0,
          outputEndSec: 10,
          subtitles: { policy: "word_by_word", sourceClipId: "clip01" },
        }],
      };

      const edl = buildRenderEdl(output, recipe, context);
      const ass = generateAssSubtitles({ edl, context, stylePresets, format: "16:9" });
      const profanityLine = ass.split("\n").find((line) => line.includes("k***a"));

      assert.ok(profanityLine, "expected censored profanity in ASS output");
      assert.ok(!ass.includes("kurwa"), "raw profanity should not appear in ASS output");
    });
  });

  it("uses displayWord for profane tokens in subtitles", () => {
    withContext((context, recipe) => {
      context.wordIndexes.clip01 = {
        clipId: "clip01",
        words: [
          { wordId: "clip01_w001", word: "hej", start: 0.5, end: 0.8, isProfanity: false },
          { wordId: "clip01_w002", word: "kurwa", start: 1.0, end: 1.4, isProfanity: true, displayWord: "k***a" },
        ],
      };

      const output = {
        outputId: "test_profanity",
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
          outputStartSec: 0,
          outputEndSec: 10,
          subtitles: { policy: "word_by_word", sourceClipId: "clip01" },
        }],
      };

      const edl = buildRenderEdl(output, recipe, context);
      const ass = generateAssSubtitles({ edl, context, stylePresets, format: "16:9" });
      const profanityLine = ass.split("\n").find((line) => line.includes("k***a"));

      assert.ok(profanityLine, "expected censored profanity in ASS output");
      assert.ok(!ass.includes("kurwa"), "raw profanity should not appear in ASS output");
    });
  });

  it("uses displayWord for non-profanity safety terms", () => {
    withContext((context, recipe) => {
      context.wordIndexes.clip01 = {
        clipId: "clip01",
        words: [{
          wordId: "clip01_w001",
          word: "morderca",
          start: 1,
          end: 1.4,
          isProfanity: false,
          safetyClass: "sensitive",
          safetyAction: "bleep",
          displayWord: "m******a",
        }],
      };
      const output = {
        outputId: "test_safety",
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
          outputStartSec: 0,
          outputEndSec: 10,
          subtitles: { policy: "word_by_word", sourceClipId: "clip01" },
        }],
      };

      const edl = buildRenderEdl(output, recipe, context);
      const ass = generateAssSubtitles({ edl, context, stylePresets, format: "16:9" });

      assert.ok(ass.includes("m******a"));
      assert.equal(ass.includes("morderca"), false);
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

describe("ass-subtitles anti-flicker", () => {
  it("merges same-start zero-duration clusters and enforces min cue duration", () => {
    const events = buildWordSubtitleEvents([
      { word: "stworzone", start: 1.78, end: 1.78 },
      { word: "przez", start: 1.78, end: 1.78 },
      { word: "Amara", start: 1.78, end: 1.78 },
      { word: "dalej", start: 2.5, end: 2.9 },
    ], {
      segment: {
        audioInSec: 0,
        outputStartSec: 20,
        audioPolicy: "from_video_ref",
      },
      segmentIndex: 0,
      segments: [{
        audioInSec: 0,
        outputStartSec: 20,
        audioPolicy: "from_video_ref",
      }],
      clipStart: 20,
      clipEnd: 25,
    });

    assert.equal(events.length, 2);
    assert.ok(events[0].end - events[0].start >= 0.35);
    assert.match(events[0].text, /Amara/);
    assert.ok(!events.some((event) => event.text === "stworzone"));
  });

  it("filters boilerplate watermark words", () => {
    assert.equal(isBoilerplateSubtitleWord({ word: "Amara.org" }), true);
    assert.equal(isBoilerplateSubtitleWord({ word: "hej" }), false);
  });

  it("filters whisper prompt echo words as safety net", () => {
    assert.equal(
      isBoilerplateSubtitleWord(
        { word: "zapisz" },
        { neighbors: [{ word: "każde" }, { word: "słowo" }] },
      ),
      true,
    );
    assert.equal(isBoilerplateSubtitleWord({ word: "bez" }), false);

    const words = [
      { word: "Zapisz", start: 0.1, end: 0.4 },
      { word: "każde", start: 0.4, end: 0.7 },
      { word: "słowo", start: 0.7, end: 1.0 },
      { word: "cześć", start: 2.0, end: 2.4 },
    ];
    const events = buildWordSubtitleEvents(filterSubtitleWords(words, 0, 5), {
      segment: {
        audioInSec: 0,
        audioOutSec: 5,
        outputStartSec: 0,
        audioPolicy: "from_video_ref",
      },
      segmentIndex: 0,
      segments: [{
        audioInSec: 0,
        audioOutSec: 5,
        outputStartSec: 0,
        audioPolicy: "from_video_ref",
      }],
      clipStart: 0,
      clipEnd: 5,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].text, "cześć");
  });
});
