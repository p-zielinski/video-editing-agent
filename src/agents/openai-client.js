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
  onUsage,
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

  if (typeof onUsage === "function" && response.usage) {
    onUsage({ model, usage: response.usage });
  }

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Pusta odpowiedź modelu");
  }

  try {
    return JSON.parse(content);
  } catch {
    const retryResponse = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
        { role: "assistant", content },
        {
          role: "user",
          content: "Your previous response was not valid JSON. Reply with valid JSON only.",
        },
      ],
    });

    if (typeof onUsage === "function" && retryResponse.usage) {
      onUsage({ model, usage: retryResponse.usage });
    }

    const retryContent = retryResponse.choices[0]?.message?.content;
    if (!retryContent) {
      throw new Error("Pusta odpowiedź modelu (retry JSON)");
    }

    return JSON.parse(retryContent);
  }
}

export const MODELS = {
  // Domyślnie GPT-5.4; ustaw OPENAI_MODEL_NANO/MINI w .env
  summarizer: process.env.OPENAI_MODEL_NANO ?? "gpt-5.4-nano",
  musicCurator: process.env.OPENAI_MODEL_NANO ?? "gpt-5.4-nano",
  director: process.env.OPENAI_MODEL_DIRECTOR ?? process.env.OPENAI_MODEL_MINI ?? "gpt-5.4-mini",
  critic: process.env.OPENAI_MODEL_CRITIC ?? process.env.OPENAI_MODEL_MINI ?? "gpt-5.4-mini",
  fixer: process.env.OPENAI_MODEL_CRITIC ?? process.env.OPENAI_MODEL_MINI ?? "gpt-5.4-mini",
  thumbnailStrategist: process.env.OPENAI_MODEL_MINI ?? "gpt-5.4-mini",
  thumbnailCritic: process.env.OPENAI_MODEL_MINI ?? "gpt-5.4-mini",
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
