import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach } from "node:test";
import {
  applySfxAiEnrichment,
  buildSfxEnrichUserText,
  describeSfxWithAi,
  enrichSfxCatalogSound,
  needsSfxAiEnrichment,
  normalizeSfxAiEnrichment,
  probeSfxEnrichTextModel,
  resetSfxEnrichModelCache,
  resolveSfxEnrichModel,
  resolveSfxEnrichTextModels,
} from "./sfx-ai-enrich.js";

describe("sfx-ai-enrich", () => {
  beforeEach(() => {
    resetSfxEnrichModelCache();
  });
  it("normalizeSfxAiEnrichment filters unknown tags and keeps description", () => {
    const normalized = normalizeSfxAiEnrichment({
      description: "Krótki metaliczny trzask uderzenia.",
      tags: ["impact", "whoosh", "not_a_real_tag"],
      category: "foley",
      useCases: ["payoff po żarcie", ""],
      loudnessCharacter: "loud",
      isLoop: false,
    });

    assert.ok(normalized);
    assert.equal(normalized.description, "Krótki metaliczny trzask uderzenia.");
    assert.deepEqual(normalized.tags, ["impact", "whoosh"]);
    assert.equal(normalized.category, "foley");
    assert.equal(normalized.useCases.length, 1);
    assert.equal(normalized.loudnessCharacter, "loud");
  });

  it("needsSfxAiEnrichment skips when aiEnrichedAt present", () => {
    assert.equal(
      needsSfxAiEnrichment({ aiEnrichedAt: "2026-01-01T00:00:00.000Z" }),
      false,
    );
    assert.equal(needsSfxAiEnrichment({ title: "Pop", tags: [] }), true);
  });

  it("applySfxAiEnrichment merges tags and stores description", () => {
    const enriched = applySfxAiEnrichment(
      { sfxId: "x", title: "Censor Beep", tags: ["alert"], integratedLufs: -8 },
      {
        description: "Krótki censor beep TV.",
        tags: ["bleep"],
        category: "foley",
        useCases: ["cenzura wulgaryzmów"],
        loudnessCharacter: "loud",
        isLoop: false,
      },
      { model: "gpt-4o-mini" },
    );

    assert.equal(enriched.description, "Krótki censor beep TV.");
    assert.ok(enriched.tags.includes("bleep"));
    assert.ok(enriched.tags.includes("alert"));
    assert.equal(enriched.aiEnrichModel, "gpt-4o-mini");
    assert.ok(enriched.aiEnrichedAt);
  });

  it("buildSfxEnrichUserText includes pixabay tags", () => {
    const text = buildSfxEnrichUserText({
      sfxId: "pixabay_sfx_1",
      title: "Whoosh",
      fileName: "whoosh.mp3",
      durationSec: 1.2,
      integratedLufs: -14,
      tags: [],
      pixabay: { tags: ["swoosh", "transition"] },
    });
    assert.match(text, /pixabayTags: swoosh, transition/);
  });

  it("resolveSfxEnrichModel picks audio-preview for audio mode", () => {
    assert.equal(resolveSfxEnrichModel({ textOnly: false }), "gpt-4o-mini-audio-preview");
    assert.deepEqual(resolveSfxEnrichTextModels().slice(0, 2), ["gpt-5.4-nano", "gpt-5.4-mini"]);
  });

  it("probeSfxEnrichTextModel caches first working model", async () => {
    const calls = [];
    const client = {
      chat: {
        completions: {
          create: async (request) => {
            calls.push(request.model);
            if (request.model === "gpt-5.5-nano") {
              const error = new Error("404 model missing");
              error.status = 404;
              throw error;
            }
            return { choices: [{ message: { content: "ok" } }] };
          },
        },
      },
    };

    process.env.OPENAI_MODEL_NANO = "gpt-5.5-nano";
    try {
      const first = await probeSfxEnrichTextModel(client);
      const second = await probeSfxEnrichTextModel(client);
      assert.equal(first, "gpt-5.4-nano");
      assert.equal(second, "gpt-5.4-nano");
      assert.equal(calls.filter((model) => model === "gpt-5.5-nano").length, 1);
    } finally {
      delete process.env.OPENAI_MODEL_NANO;
    }
  });

  it("describeSfxWithAi falls back to next text model when first unavailable", async () => {
    const audioPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfx-audio-fallback-")), "sample.wav");
    fs.writeFileSync(audioPath, "fake");

    const tried = [];
    const client = {
      chat: {
        completions: {
          create: async (request) => {
            tried.push(request.model);
            if (request.model.includes("audio") || request.model === "gpt-5.5-nano") {
              const error = new Error("404 The model does not exist or you do not have access to it.");
              error.status = 404;
              throw error;
            }
            return {
              usage: { total_tokens: 42 },
              choices: [{
                message: {
                  content: JSON.stringify({
                    description: "Opis z fallbacku tekstowego.",
                    tags: ["impact"],
                    category: "foley",
                    useCases: ["uderzenie"],
                    loudnessCharacter: "loud",
                    isLoop: false,
                  }),
                },
              }],
            };
          },
        },
      },
    };

    process.env.OPENAI_MODEL_NANO = "gpt-5.5-nano";
    try {
      const result = await describeSfxWithAi(client, {
        sound: { sfxId: "x", title: "Pop", fileName: "pop.mp3", tags: [] },
        audioFilePath: audioPath,
      });

      assert.ok(tried.includes("gpt-4o-mini-audio-preview"));
      assert.equal(tried.filter((model) => model === "gpt-5.5-nano").length, 1);
      assert.ok(tried.includes("gpt-5.4-nano"));
      assert.equal(result?.description, "Opis z fallbacku tekstowego.");
    } finally {
      delete process.env.OPENAI_MODEL_NANO;
      fs.rmSync(path.dirname(audioPath), { recursive: true, force: true });
    }
  });

  it("enrichSfxCatalogSound uses mocked describeFn", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-enrich-"));
    const filePath = path.join(tmpDir, "test.mp3");
    fs.writeFileSync(filePath, "fake");

    const sound = {
      sfxId: "test",
      fileName: "test.mp3",
      title: "Test",
      tags: [],
      category: "foley",
      durationSec: 1,
    };

    try {
      const result = await enrichSfxCatalogSound(sound, {
        sfxDir: tmpDir,
        client: {},
        textOnly: true,
        describeFn: async () => ({
          description: "Testowy whoosh.",
          tags: ["whoosh"],
          category: "transition",
          useCases: ["przejście"],
          loudnessCharacter: "medium",
          isLoop: false,
        }),
        prepareSampleFn: async (samplePath) => ({ samplePath, cleanup: null }),
      });

      assert.equal(result.skipped, false);
      assert.equal(result.sound.description, "Testowy whoosh.");
      assert.ok(result.sound.tags.includes("whoosh"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
