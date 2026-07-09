import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  WHISPER_EDIT_PROMPT,
  OPENAI_WHISPER_MODEL_DEFAULT,
  resolveOpenAIWhisperModel,
  buildWhisperPrompt,
} from "./transcribe.js";

describe("transcribe", () => {
  let previousWhisperModel;

  before(() => {
    previousWhisperModel = process.env.OPENAI_WHISPER_MODEL;
    delete process.env.OPENAI_WHISPER_MODEL;
  });

  after(() => {
    if (previousWhisperModel === undefined) {
      delete process.env.OPENAI_WHISPER_MODEL;
    } else {
      process.env.OPENAI_WHISPER_MODEL = previousWhisperModel;
    }
  });

  it("WHISPER_EDIT_PROMPT requests literal Polish transcription with hesitations", () => {
    assert.match(WHISPER_EDIT_PROMPT, /dosłownie/i);
    assert.match(WHISPER_EDIT_PROMPT, /yyy|eee|ooo|mmm|um/i);
    assert.match(WHISPER_EDIT_PROMPT, /angielsk/i);
    assert.match(WHISPER_EDIT_PROMPT, /wulgaryzm/i);
  });

  it("buildWhisperPrompt returns base prompt without expectedTerms", () => {
    assert.equal(buildWhisperPrompt(), WHISPER_EDIT_PROMPT);
    assert.equal(buildWhisperPrompt({ expectedTerms: [] }), WHISPER_EDIT_PROMPT);
  });

  it("buildWhisperPrompt appends expected terms", () => {
    const prompt = buildWhisperPrompt({ expectedTerms: ["Elden Ring", "Breaking Bad"] });
    assert.ok(prompt.startsWith(WHISPER_EDIT_PROMPT));
    assert.match(prompt, /Elden Ring/);
    assert.match(prompt, /Breaking Bad/);
  });

  it("resolveOpenAIWhisperModel defaults to whisper-1", () => {
    assert.equal(resolveOpenAIWhisperModel(), "whisper-1");
    assert.equal(OPENAI_WHISPER_MODEL_DEFAULT, "whisper-1");
  });
});
