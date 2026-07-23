import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  stripWhisperPromptEchoes,
  tokenizePrompt,
  isWhisperPromptEchoWord,
} from "./whisper-prompt-echo.js";
import { WHISPER_EDIT_PROMPT } from "./transcribe.js";

function clip16LikeEchoPrefix() {
  return [
    { word: "Zapisz", start: 11.68, end: 12.04 },
    { word: "każde", start: 12.04, end: 12.24 },
    { word: "słowo", start: 12.24, end: 12.24 },
    { word: "włącznie", start: 12.4, end: 12.4 },
    { word: "z", start: 12.4, end: 12.4 },
    { word: "zająknięciami", start: 12.4, end: 12.46 },
    { word: "Zapisz", start: 17.44, end: 17.8 },
    { word: "każde", start: 17.8, end: 17.82 },
    { word: "słowo", start: 17.82, end: 29.84 },
    { word: "bez", start: 29.84, end: 29.84 },
    { word: "eufemizmów", start: 29.84, end: 29.84 },
    { word: "ani", start: 48.28, end: 48.28 },
    { word: "cenzury", start: 48.28, end: 48.28 },
    { word: "Myślę", start: 60.94, end: 61.42 },
    { word: "że", start: 61.56, end: 61.56 },
    { word: "to", start: 62.1, end: 62.4 },
    { word: "słowo", start: 62.5, end: 62.8 },
    { word: "ma", start: 62.9, end: 63.1 },
    { word: "znaczenie", start: 63.2, end: 63.8 },
  ];
}

describe("whisper-prompt-echo", () => {
  it("tokenizePrompt normalizes whisper edit prompt tokens", () => {
    const tokens = tokenizePrompt(WHISPER_EDIT_PROMPT);
    assert.ok(tokens.includes("zapisz"));
    assert.ok(tokens.includes("eufemizmów"));
    assert.ok(tokens.includes("transkrybuj"));
  });

  it("strips clip16-like prompt echo prefix and keeps real speech", () => {
    const stripped = stripWhisperPromptEchoes(clip16LikeEchoPrefix());
    assert.equal(stripped[0].word, "Myślę");
    assert.ok(!stripped.some((entry) => entry.word === "Zapisz"));
    assert.ok(!stripped.some((entry) => entry.word === "eufemizmów"));
    assert.equal(stripped.find((entry) => entry.word === "słowo")?.start, 62.5);
  });

  it("isWhisperPromptEchoWord flags distinctive prompt tokens with neighbors", () => {
    assert.equal(
      isWhisperPromptEchoWord(
        { word: "zapisz" },
        { neighbors: [{ word: "każde" }, { word: "słowo" }] },
      ),
      true,
    );
    assert.equal(isWhisperPromptEchoWord({ word: "bez" }), false);
    assert.equal(isWhisperPromptEchoWord({ word: "hej" }), false);
  });

  it("strips real clip16 words artifact prefix", () => {
    const fixturePath = path.resolve(
      "output/.work/51cd206d/01-words-clip16.json",
    );
    let words;
    try {
      words = JSON.parse(readFileSync(fixturePath, "utf8")).words;
    } catch {
      return;
    }

    const stripped = stripWhisperPromptEchoes(words);
    assert.match(stripped[0].word, /myśl/i);
    assert.ok(stripped[0].start < 65);
    assert.ok(!stripped.slice(0, 5).some((entry) => /zapisz/i.test(entry.word)));
  });
});
