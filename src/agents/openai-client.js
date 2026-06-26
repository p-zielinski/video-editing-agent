import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function createOpenAIClient(apiKey) {
  return new OpenAI({ apiKey, maxRetries: 2, timeout: 5 * 60 * 1000 });
}

export function loadPrompt(name, { version } = {}) {
  const promptVersion = version ?? process.env.PROMPT_VERSION ?? "v1";
  const versionedPath = path.join(ROOT, "prompts", promptVersion, `${name}.md`);
  const legacyPath = path.join(ROOT, "prompts", `${name}.md`);

  if (fs.existsSync(versionedPath)) {
    return fs.readFileSync(versionedPath, "utf8");
  }
  if (fs.existsSync(legacyPath)) {
    return fs.readFileSync(legacyPath, "utf8");
  }
  return "";
}

export function getPromptVersion({ version } = {}) {
  return version ?? process.env.PROMPT_VERSION ?? "v1";
}

export async function chatJson(client, {
  model,
  system,
  user,
  temperature = 0.4,
}) {
  const response = await client.chat.completions.create({
    model,
    temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Pusta odpowiedź modelu");
  }

  return JSON.parse(content);
}

export const MODELS = {
  // Domyślnie GPT-5.5; ustaw OPENAI_MODEL_NANO/MINI lub użyj gpt-4.1-* jako fallback w .env
  summarizer: process.env.OPENAI_MODEL_NANO ?? "gpt-5.5-nano",
  director: process.env.OPENAI_MODEL_MINI ?? "gpt-5.5-mini",
  critic: process.env.OPENAI_MODEL_MINI ?? "gpt-5.5-mini",
  fixer: process.env.OPENAI_MODEL_MINI ?? "gpt-5.5-mini",
  thumbnailStrategist: process.env.OPENAI_MODEL_MINI ?? "gpt-5.5-mini",
  thumbnailCritic: process.env.OPENAI_MODEL_MINI ?? "gpt-5.5-mini",
};

export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

export async function embedTexts(client, texts) {
  if (texts.length === 0) {
    return [];
  }

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });

  return response.data
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.embedding);
}

export function createOpenAIEmbedFn(apiKey) {
  const client = createOpenAIClient(apiKey);
  return async (texts) => embedTexts(client, texts);
}
