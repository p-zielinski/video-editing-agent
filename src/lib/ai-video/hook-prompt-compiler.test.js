import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compileHookPrompt,
  HOOK_PROMPT_MAX_LENGTH,
} from "./hook-prompt-compiler.js";

describe("compileHookPrompt", () => {
  const abstraction = {
    L3: {
      sessionSummary: "Rowerzysta walczy z trudnym podjazdem i dociera na szczyt.",
      narrativeArc: "wysiłek → kryzys → satysfakcja",
    },
    L1: [{
      sceneId: "clip01_scene001",
      summary: "Rowerzysta zaczyna stromy podjazd.",
      topics: ["cycling", "outdoors"],
    }],
    L2: [{
      segmentId: "seg001",
      sceneIds: ["clip01_scene001"],
      summary: "Początek wspinaczki",
    }],
  };

  const hookScene = { sceneId: "clip01_scene001" };

  it("builds legacy prompt when brief is absent", () => {
    const prompt = compileHookPrompt({ abstraction, hookScene });
    assert.ok(prompt.includes("cycling"));
    assert.ok(prompt.includes("trudnym podjazdem"));
    assert.ok(prompt.includes("Rowerzysta zaczyna stromy podjazd"));
    assert.ok(prompt.includes("vertical 9:16 safe zone"));
    assert.equal(prompt.includes("clip01_scene001"), false);
    assert.ok(prompt.length <= HOOK_PROMPT_MAX_LENGTH);
  });

  it("includes contextual brief fields deterministically", () => {
    const prompt = compileHookPrompt({
      brief: {
        strategy: "contextual",
        narrativePromise: "Zapowiedź wysiłku bez ujawniania szczytu",
        contextualLink: "Łączy determinację z podjazdem",
        visualTone: "napięcie i ruch",
        mustAvoid: ["spoilery", "napisy"],
      },
      abstraction,
      hookScene,
    });

    assert.ok(prompt.includes("Zapowiedź wysiłku bez ujawniania szczytu"));
    assert.ok(prompt.includes("Łączy determinację z podjazdem"));
    assert.ok(prompt.includes("Visual tone: napięcie i ruch"));
    assert.ok(prompt.includes("Must avoid: spoilery, napisy"));
    assert.equal(prompt.includes("non-obvious visual element"), false);
  });

  it("includes unexpected element for intentionally_unexpected strategy", () => {
    const prompt = compileHookPrompt({
      brief: {
        strategy: "intentionally_unexpected",
        narrativePromise: "Coś jest nie tak z tym podjazdem",
        contextualLink: "Metafora wysiłku bez payoffu",
        unexpectedElement: "Odbicie słońca w kroplach potu na kierownicy",
        mustAvoid: ["spoilery"],
      },
      abstraction,
      hookScene,
    });

    assert.ok(prompt.includes("Odbicie słońca w kroplach potu na kierownicy"));
    assert.ok(prompt.includes("non-obvious visual element"));
    assert.ok(prompt.includes("Do not reveal facts"));
  });

  it("truncates to provider max length", () => {
    const prompt = compileHookPrompt({
      brief: {
        strategy: "contextual",
        narrativePromise: "x".repeat(3000),
        contextualLink: "y".repeat(3000),
        mustAvoid: ["z"],
      },
      abstraction,
      hookScene,
    });
    assert.equal(prompt.length, HOOK_PROMPT_MAX_LENGTH);
  });
});
