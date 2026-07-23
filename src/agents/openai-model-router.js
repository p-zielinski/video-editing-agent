import { randomUUID } from "node:crypto";
import {
  classifyModelPool,
  estimateChatTokens,
  isQuotaTrackingEnabled,
} from "../lib/openai-daily-usage.js";
import { parseOpenAIUsage } from "../lib/gpt-usage-log.js";
import {
  tryReadLlmResponseCache,
  writeLlmResponseCache,
} from "../lib/llm-response-cache.js";
import { resolveAgentModels } from "./openai-client.js";

/** @type {Record<string, string[]>} */
const BALANCED_ROLE_TIERS = {
  summarizerL1: ["nano", "mini"],
  summarizerL2: ["mini", "nano"],
  summarizerL3: ["flagship", "mini", "nano"],
  musicCurator: ["nano", "mini"],
  director: ["flagship", "mini"],
  superDirector: ["flagship", "mini"],
  segmentDirector: ["mini"],
  directorDrillDown: ["mini", "nano"],
  critic: ["mini", "nano"],
  superCritic: ["mini", "nano"],
  fixer: ["mini", "nano"],
  fixerEscalation: ["flagship"],
  safetyClassifier: ["nano", "mini"],
  thumbnailStrategist: ["mini", "nano"],
  thumbnailCritic: ["nano", "mini"],
  twelvelabsShort: ["mini"],
};

const ROLE_TO_MODEL_KEY = {
  summarizerL1: "summarizerL1",
  summarizerL2: "summarizerL2",
  summarizerL3: "summarizerL3",
  musicCurator: "musicCurator",
  director: "director",
  superDirector: "superDirector",
  segmentDirector: "segmentDirector",
  directorDrillDown: "directorDrillDown",
  critic: "critic",
  superCritic: "critic",
  fixer: "fixer",
  fixerEscalation: "fixerEscalation",
  safetyClassifier: "safetyClassifier",
  thumbnailStrategist: "thumbnailStrategist",
  thumbnailCritic: "thumbnailCritic",
  twelvelabsShort: "twelvelabsShort",
};

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // short sync backoff for tests and rate-limit retries
  }
}

export function isModelDowngradeEnabled(env = process.env) {
  return env.OPENAI_MODEL_DOWNGRADE_ENABLED === "1";
}

export function resolveRolePolicy(role, env = process.env) {
  const tiers = BALANCED_ROLE_TIERS[role] ?? ["mini"];
  return {
    role,
    tiers,
    allowCrossPoolDowngrade: role !== "fixerEscalation",
  };
}

/**
 * @param {"nano" | "mini" | "flagship"} tier
 * @param {Record<string, string | undefined>} env
 */
export function resolveTierModel(tier, env = process.env) {
  const nano = env.OPENAI_MODEL_NANO ?? "gpt-5.4-nano";
  const mini = env.OPENAI_MODEL_MINI ?? "gpt-5.4-mini";
  const flagship = env.OPENAI_MODEL_FLAGSHIP ?? "gpt-5.4";
  switch (tier) {
    case "nano":
      return nano;
    case "mini":
      return mini;
    case "flagship":
      return flagship;
    default:
      return mini;
  }
}

export function resolvePreferredModelForRole(role, env = process.env) {
  const models = resolveAgentModels(env);
  const modelKey = ROLE_TO_MODEL_KEY[role] ?? role;
  return models[modelKey] ?? resolveTierModel("mini", env);
}

/**
 * @param {{ role: string, env?: Record<string, string | undefined>, quotaSnapshot?: object }} params
 */
export function resolveModelCandidates({ role, env = process.env, quotaSnapshot = null }) {
  const policy = resolveRolePolicy(role, env);
  const candidates = [];
  const seen = new Set();

  for (const tier of policy.tiers) {
    const model = resolveTierModel(tier, env);
    if (seen.has(model)) {
      continue;
    }
    const pool = classifyModelPool(model);
    if (quotaSnapshot?.pools?.[pool]?.exhausted) {
      continue;
    }
    seen.add(model);
    candidates.push(model);
  }

  if (candidates.length === 0) {
    const fallback = resolvePreferredModelForRole(role, env);
    if (!seen.has(fallback)) {
      candidates.push(fallback);
    }
  }

  return candidates;
}

/**
 * @param {unknown} error
 */
export function classifyOpenAIError(error) {
  const status = error?.status ?? error?.statusCode;
  const code = String(error?.code ?? "").toLowerCase();
  const type = String(error?.type ?? "").toLowerCase();
  const message = String(error?.message ?? error ?? "").toLowerCase();

  if (status === 404 || /does not exist or you do not have access/i.test(message)) {
    return { kind: "model_unavailable", retrySameModel: false, markPoolExhausted: false };
  }

  if (
    code === "insufficient_quota"
    || type === "insufficient_quota"
    || /exceeded your current quota/i.test(message)
    || /billing hard limit/i.test(message)
  ) {
    return { kind: "quota_exhausted", retrySameModel: false, markPoolExhausted: true };
  }

  if (status === 429 || code === "rate_limit_exceeded" || type === "rate_limit_exceeded") {
    return { kind: "rate_limit", retrySameModel: true, markPoolExhausted: false };
  }

  if (status >= 500 || /premature close/i.test(message) || /network/i.test(message)) {
    return { kind: "retryable", retrySameModel: true, markPoolExhausted: false };
  }

  return { kind: "fatal", retrySameModel: false, markPoolExhausted: false };
}

async function createChatCompletion(client, {
  model,
  system,
  userContent,
  temperature,
  extraMessages = [],
}) {
  return client.chat.completions.create({
    model,
    temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
      ...extraMessages,
    ],
  });
}

async function invokeChatJsonOnce(client, {
  model,
  system,
  userContent,
  temperature,
  extraMessages = [],
  onUsage,
  requestedModel,
  callId,
}) {
  const response = await createChatCompletion(client, {
    model,
    system,
    userContent,
    temperature,
    extraMessages,
  });

  if (typeof onUsage === "function" && response.usage) {
    onUsage({
      model,
      requestedModel: requestedModel ?? model,
      usage: response.usage,
      callId,
    });
  }

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Pusta odpowiedź modelu");
  }

  try {
    return { parsed: JSON.parse(content), usage: response.usage, model };
  } catch {
    const retryResponse = await createChatCompletion(client, {
      model,
      system,
      userContent,
      temperature: 0,
      extraMessages: [
        { role: "assistant", content },
        {
          role: "user",
          content: "Your previous response was not valid JSON. Reply with valid JSON only.",
        },
      ],
    });

    if (typeof onUsage === "function" && retryResponse.usage) {
      onUsage({
        model,
        requestedModel: requestedModel ?? model,
        usage: retryResponse.usage,
        callId: callId ? `${callId}:json-retry` : undefined,
      });
    }

    const retryContent = retryResponse.choices[0]?.message?.content;
    if (!retryContent) {
      throw new Error("Pusta odpowiedź modelu (retry JSON)");
    }

    return { parsed: JSON.parse(retryContent), usage: retryResponse.usage, model };
  }
}

function shouldUseRouter(env = process.env) {
  return isQuotaTrackingEnabled(env) || isModelDowngradeEnabled(env);
}

function getMaxRetries(env = process.env) {
  const parsed = Number.parseInt(env.OPENAI_ROUTER_MAX_RETRIES ?? "2", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}

function getMaxDowngrades(env = process.env) {
  const parsed = Number.parseInt(env.OPENAI_ROUTER_MAX_DOWNGRADES ?? "1", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

/**
 * @param {import("openai").OpenAI} client
 * @param {{
 *   role?: string,
 *   system: string,
 *   user?: string,
 *   userContent?: string | Array<object>,
 *   temperature?: number,
 *   onUsage?: Function,
 *   quotaTracker?: object | null,
 *   batchId?: string | null,
 *   step?: string | null,
 *   env?: Record<string, string | undefined>,
 *   model?: string | null,
 * }} options
 */
export async function executeRoutedChatJson(client, {
  role,
  system,
  user,
  userContent,
  temperature = 0.4,
  onUsage,
  quotaTracker = null,
  batchId = null,
  step = null,
  cacheKey = null,
  workDir = null,
  env = process.env,
  model: explicitModel = null,
}) {
  if (!role && !explicitModel) {
    throw new Error("executeRoutedChatJson requires role or explicit model");
  }

  const resolvedUserContent = userContent ?? user;
  if (resolvedUserContent == null) {
    throw new Error("executeRoutedChatJson requires user or userContent");
  }

  const cacheContext = {
    batchId,
    workDir,
    step,
    role,
    cacheKey,
    env,
  };
  const cached = tryReadLlmResponseCache(cacheContext);
  if (cached) {
    return cached.response;
  }

  const quotaSnapshot = quotaTracker?.snapshot?.() ?? null;
  const requestedModel = explicitModel ?? resolvePreferredModelForRole(role, env);
  const candidates = explicitModel
    ? [explicitModel]
    : resolveModelCandidates({ role, env, quotaSnapshot });

  if (role === "fixerEscalation" && candidates.length === 0) {
    const error = new Error("premium_quota_required: fixer escalation requires flagship pool");
    error.code = "PREMIUM_QUOTA_REQUIRED";
    throw error;
  }

  const maxDowngrades = getMaxDowngrades(env);
  const maxRetries = getMaxRetries(env);
  let downgradeCount = 0;
  let lastError = null;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const model = candidates[candidateIndex];
    const callId = randomUUID();
    const estimatedTokens = estimateChatTokens({
      system,
      user: typeof resolvedUserContent === "string" ? resolvedUserContent : "",
      userContent: typeof resolvedUserContent === "string" ? undefined : resolvedUserContent,
      role: role ?? "default",
    });

    if (quotaTracker && isQuotaTrackingEnabled(env)) {
      try {
        quotaTracker.reserve({
          callId,
          role,
          step,
          model,
          estimatedTokens,
        });
      } catch (error) {
        if (candidateIndex < candidates.length - 1 && downgradeCount < maxDowngrades) {
          downgradeCount += 1;
          continue;
        }
        if (role === "fixerEscalation") {
          const premiumError = new Error("premium_quota_required: fixer escalation requires flagship pool");
          premiumError.code = "PREMIUM_QUOTA_REQUIRED";
          throw premiumError;
        }
        throw error;
      }
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        /** @type {{ promptTokens: number, completionTokens: number, totalTokens: number } | null} */
        let accumulatedUsage = null;
        const wrappedOnUsage = (event) => {
          const parsed = parseOpenAIUsage(event.usage);
          if (parsed) {
            accumulatedUsage = accumulatedUsage
              ? {
                promptTokens: accumulatedUsage.promptTokens + parsed.promptTokens,
                completionTokens: accumulatedUsage.completionTokens + parsed.completionTokens,
                totalTokens: accumulatedUsage.totalTokens + parsed.totalTokens,
              }
              : parsed;
          }
          if (typeof onUsage === "function") {
            onUsage(event);
          }
        };

        const { parsed, usage, model: actualModel } = await invokeChatJsonOnce(client, {
          model,
          system,
          userContent: resolvedUserContent,
          temperature,
          onUsage: wrappedOnUsage,
          requestedModel,
          callId,
        });

        if (quotaTracker && isQuotaTrackingEnabled(env)) {
          quotaTracker.commit({
            callId,
            model: actualModel ?? model,
            usage: accumulatedUsage ?? usage,
            step,
            batchId,
          });
        }

        writeLlmResponseCache({
          ...cacheContext,
          response: parsed,
          model: actualModel ?? model,
          callId,
        });

        return parsed;
      } catch (error) {
        lastError = error;
        const classification = classifyOpenAIError(error);

        if (classification.markPoolExhausted && quotaTracker) {
          const pool = classifyModelPool(model);
          if (pool === "premium" || pool === "mini") {
            quotaTracker.markPoolExhausted({ pool, reason: classification.kind });
          }
        }

        if (quotaTracker && isQuotaTrackingEnabled(env)) {
          quotaTracker.release({ callId, reason: classification.kind });
        }

        if (classification.retrySameModel && attempt < maxRetries) {
          sleepMs(100 * (attempt + 1));
          continue;
        }

        if (
          (classification.kind === "quota_exhausted" || classification.kind === "model_unavailable")
          && candidateIndex < candidates.length - 1
          && downgradeCount < maxDowngrades
        ) {
          downgradeCount += 1;
          break;
        }

        if (role === "fixerEscalation" && classification.kind === "quota_exhausted") {
          const premiumError = new Error("premium_quota_required: fixer escalation requires flagship pool");
          premiumError.code = "PREMIUM_QUOTA_REQUIRED";
          throw premiumError;
        }

        if (candidateIndex === candidates.length - 1) {
          throw error;
        }
        downgradeCount += 1;
        break;
      }
    }
  }

  throw lastError ?? new Error("Routed chat failed without error");
}

/**
 * Multimodal JSON chat (text + image_url parts). Same reserve/commit loop as text chat.
 */
export async function executeRoutedChatJsonMultimodal(client, options) {
  if (options.userContent == null) {
    throw new Error("executeRoutedChatJsonMultimodal requires userContent");
  }
  return executeRoutedChatJson(client, options);
}

export { shouldUseRouter };
