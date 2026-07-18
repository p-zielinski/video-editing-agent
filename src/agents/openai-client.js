import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { fileURLToPath } from "node:url";
import { executeRoutedChatJson, shouldUseRouter } from "./openai-model-router.js";
import { isQuotaTrackingEnabled } from "../lib/openai-daily-usage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Work around Node 24.9–24.17 keep-alive false ERR_STREAM_PREMATURE_CLOSE. */
export function createOpenAIFetch() {
  return (url, init = {}) => {
    const next = { ...init, keepalive: false };
    if (
      init.body
      && typeof init.body !== "string"
      && !(init.body instanceof Buffer)
      && init.duplex === undefined
    ) {
      next.duplex = "half";
    }
    return fetch(url, next);
  };
}

export function createOpenAIClient(apiKey, options = {}) {
  return new OpenAI({
    apiKey,
    maxRetries: options.maxRetries ?? 2,
    timeout: options.timeout ?? 5 * 60 * 1000,
    fetch: options.fetch ?? createOpenAIFetch(),
  });
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
  role,
  system,
  user,
  temperature = 0.4,
  onUsage,
  quotaTracker,
  batchId,
  step,
}) {
  if (shouldUseRouter() && (role || quotaTracker || isQuotaTrackingEnabled())) {
    return executeRoutedChatJson(client, {
      role,
      model,
      system,
      user,
      temperature,
      onUsage,
      quotaTracker,
      batchId,
      step,
    });
  }

  const resolvedModel = model ?? (role ? undefined : null);
  if (!resolvedModel) {
    throw new Error("chatJson requires model when routing is disabled");
  }

  const response = await client.chat.completions.create({
    model: resolvedModel,
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
      model: resolvedModel,
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

export function resolveAgentModels(env = {}) {
  const nano = env.OPENAI_MODEL_NANO ?? "gpt-5.4-nano";
  const mini = env.OPENAI_MODEL_MINI ?? "gpt-5.4-mini";
  const flagship = env.OPENAI_MODEL_FLAGSHIP ?? "gpt-5.4";
  const director = env.OPENAI_MODEL_DIRECTOR ?? flagship;

  return {
    // Backward-compatible alias for callers that have not split L1/L2/L3 yet.
    summarizer: env.OPENAI_MODEL_SUMMARIZER_L1 ?? nano,
    summarizerL1: env.OPENAI_MODEL_SUMMARIZER_L1 ?? nano,
    summarizerL2: env.OPENAI_MODEL_SUMMARIZER_L2 ?? mini,
    summarizerL3: env.OPENAI_MODEL_SUMMARIZER_L3 ?? flagship,
    musicCurator: env.OPENAI_MODEL_MUSIC_CURATOR ?? nano,
    director,
    superDirector: env.OPENAI_MODEL_SUPER_DIRECTOR ?? director,
    segmentDirector: env.OPENAI_MODEL_SEGMENT_DIRECTOR ?? mini,
    directorDrillDown: env.OPENAI_MODEL_DIRECTOR_DRILLDOWN ?? mini,
    critic: env.OPENAI_MODEL_CRITIC ?? mini,
    fixer: env.OPENAI_MODEL_FIXER ?? mini,
    fixerEscalation: env.OPENAI_MODEL_FIXER_ESCALATION ?? flagship,
    safetyClassifier: env.OPENAI_MODEL_SAFETY_CLASSIFIER ?? mini,
    thumbnailStrategist: env.OPENAI_MODEL_THUMBNAIL_STRATEGIST ?? mini,
    thumbnailCritic: env.OPENAI_MODEL_THUMBNAIL_CRITIC ?? mini,
  };
}

export const MODELS = resolveAgentModels(process.env);

export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

export async function embedTexts(client, texts, {
  onUsage,
  quotaTracker,
  batchId,
  step = "topic_index",
} = {}) {
  if (texts.length === 0) {
    return [];
  }

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });

  if (typeof onUsage === "function" && response.usage) {
    onUsage({ model: EMBEDDING_MODEL, usage: response.usage });
  }
  if (quotaTracker?.recordPaidUsage) {
    quotaTracker.recordPaidUsage({
      type: "embedding",
      model: EMBEDDING_MODEL,
      usage: response.usage,
      step,
      batchId,
    });
  }

  return response.data
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.embedding);
}

export function createOpenAIEmbedFn(apiKey, { quotaTracker, batchId, step } = {}) {
  const client = createOpenAIClient(apiKey);
  return async (texts) => embedTexts(client, texts, { quotaTracker, batchId, step });
}
