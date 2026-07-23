import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseOpenAIUsage } from "./gpt-usage-log.js";

const DEFAULT_PREMIUM_LIMIT = 250_000;
const DEFAULT_MINI_LIMIT = 2_500_000;
const DEFAULT_RESERVE_PERCENT = 5;
const DEFAULT_RESERVATION_TTL_MINUTES = 30;
const LOCK_STALE_MS = 5 * 60 * 1000;

/** @type {Record<string, number>} */
const OUTPUT_RESERVE_BY_ROLE = {
  summarizerL1: 500,
  summarizerL2: 1500,
  summarizerL3: 4000,
  musicCurator: 800,
  director: 12000,
  superDirector: 8000,
  segmentDirector: 12000,
  directorDrillDown: 8000,
  critic: 6000,
  superCritic: 6000,
  fixer: 12000,
  fixerEscalation: 12000,
  safetyClassifier: 200,
  thumbnailStrategist: 4000,
  thumbnailCritic: 2000,
  sfxTextEnrich: 800,
  twelvelabsShort: 4000,
  default: 2000,
};

/**
 * @param {string} model
 * @returns {"premium" | "mini" | "paidOther"}
 */
export function classifyModelPool(model) {
  const normalized = String(model ?? "").toLowerCase().trim();
  if (!normalized) {
    return "paidOther";
  }

  if (
    normalized.includes("whisper")
    || normalized.includes("embedding")
    || normalized.includes("audio-preview")
    || normalized.includes("realtime")
    || normalized.includes("tts")
    || normalized.includes("dall-e")
  ) {
    return "paidOther";
  }

  if (
    normalized.includes("-mini")
    || normalized.includes("-nano")
    || normalized === "codex-mini-latest"
    || normalized.includes("codex-mini")
  ) {
    return "mini";
  }

  if (
    /^gpt-5(\.|$|-chat)/.test(normalized)
    || normalized === "gpt-4.1"
    || normalized === "gpt-4o"
    || /^o[134](-|$)/.test(normalized)
  ) {
    return "premium";
  }

  return "paidOther";
}

/**
 * @param {Date} date
 * @param {string} timezone
 */
export function formatQuotaDateKey(date, timezone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

/**
 * Flatten multimodal user content to a text string for token estimation.
 * @param {string | Array<{ type?: string, text?: string }> | undefined} userContent
 */
export function flattenUserContentForEstimate(userContent) {
  if (userContent == null) {
    return "";
  }
  if (typeof userContent === "string") {
    return userContent;
  }
  if (!Array.isArray(userContent)) {
    return "";
  }
  return userContent
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part?.type === "text" && part.text) {
        return part.text;
      }
      // Rough vision token stand-in when image_url is present (detail=low ~85 tokens ≈ ~300 chars)
      if (part?.type === "image_url") {
        return "x".repeat(300);
      }
      return "";
    })
    .join(" ");
}

/**
 * @param {{ system?: string, user?: string, userContent?: string | Array<object>, role?: string }} params
 */
export function estimateChatTokens({ system = "", user = "", userContent, role = "default" }) {
  const userText = userContent != null
    ? flattenUserContentForEstimate(userContent)
    : String(user);
  const inputChars = String(system).length + userText.length;
  const inputEstimate = Math.ceil(inputChars / 3.5);
  const outputReserve = OUTPUT_RESERVE_BY_ROLE[role] ?? OUTPUT_RESERVE_BY_ROLE.default;
  return inputEstimate + outputReserve;
}

/**
 * @param {Array<{ model?: string, usage?: { promptTokens?: number, completionTokens?: number, totalTokens?: number } }>} records
 */
export function summarizeByModel(records) {
  /** @type {Record<string, { calls: number, promptTokens: number, completionTokens: number, totalTokens: number, pool: string }>} */
  const byModel = {};
  for (const record of records) {
    const model = record.model ?? "unknown";
    const usage = record.usage ?? {};
    byModel[model] = byModel[model] ?? {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      pool: classifyModelPool(model),
    };
    const bucket = byModel[model];
    bucket.calls += 1;
    bucket.promptTokens += usage.promptTokens ?? 0;
    bucket.completionTokens += usage.completionTokens ?? 0;
    bucket.totalTokens += usage.totalTokens ?? 0;
  }
  return byModel;
}

function parseWarnPercents(raw) {
  if (!raw) {
    return [70, 90, 100];
  }
  return raw
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function emptyPoolState(limit) {
  return {
    usedTokens: 0,
    reservedTokens: 0,
    remainingTokens: limit,
    calls: 0,
    exhausted: false,
  };
}

function createEmptyDocument({
  date,
  timezone,
  limits,
}) {
  return {
    version: "1.0",
    scope: "project",
    date,
    timezone,
    updatedAt: new Date().toISOString(),
    limits: {
      premium: limits.premium,
      mini: limits.mini,
    },
    pools: {
      premium: emptyPoolState(limits.premium),
      mini: emptyPoolState(limits.mini),
      paidOther: {
        calls: 0,
        inputTokens: 0,
        audioSeconds: 0,
      },
    },
    models: {},
    steps: {},
    batches: {},
    reservations: {},
    committedCallIds: [],
    totals: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  };
}

function recomputePoolRemaining(pool, limit) {
  pool.remainingTokens = Math.max(0, limit - pool.usedTokens - pool.reservedTokens);
}

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait for short lock retries
  }
}

function acquireDailyLock(lockPath, maxAttempts = 50) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore stale cleanup races
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // another process may have released the lock
      }
      sleepMs(20 + attempt * 5);
    }
  }
  throw new Error(`Could not acquire daily usage lock: ${lockPath}`);
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readDailyDocument(filePath, { date, timezone, limits }) {
  if (!fs.existsSync(filePath)) {
    return createEmptyDocument({ date, timezone, limits });
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      ...createEmptyDocument({ date, timezone, limits }),
      ...parsed,
      pools: {
        ...createEmptyDocument({ date, timezone, limits }).pools,
        ...parsed.pools,
      },
      limits: {
        premium: limits.premium,
        mini: limits.mini,
      },
      reservations: parsed.reservations ?? {},
      committedCallIds: parsed.committedCallIds ?? [],
    };
  } catch {
    return createEmptyDocument({ date, timezone, limits });
  }
}

function cleanupExpiredReservations(document, limits, ttlMinutes) {
  const now = Date.now();
  for (const [callId, reservation] of Object.entries(document.reservations ?? {})) {
    const expiresAt = Date.parse(reservation.expiresAt ?? "");
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      const poolName = reservation.pool;
      if (poolName === "premium" || poolName === "mini") {
        document.pools[poolName].reservedTokens = Math.max(
          0,
          document.pools[poolName].reservedTokens - (reservation.tokens ?? 0),
        );
        recomputePoolRemaining(document.pools[poolName], limits[poolName]);
      }
      delete document.reservations[callId];
    }
  }
}

function applyReserve(document, {
  callId,
  role,
  step,
  model,
  estimatedTokens,
  batchId,
  limits,
  reservePercent,
  reservationTtlMinutes,
}) {
  if (document.reservations[callId]) {
    return;
  }
  const pool = classifyModelPool(model);
  if (pool === "paidOther") {
    return;
  }
  if (document.pools[pool].exhausted) {
    throw new Error(`${pool} pool exhausted`);
  }
  const buffer = Math.ceil(limits[pool] * (reservePercent / 100));
  const available = limits[pool] - document.pools[pool].usedTokens - document.pools[pool].reservedTokens - buffer;
  if (estimatedTokens > available) {
    document.pools[pool].exhausted = true;
    throw new Error(`${pool} pool exhausted`);
  }
  document.reservations[callId] = {
    callId,
    batchId: batchId ?? null,
    role: role ?? null,
    step: step ?? null,
    model,
    pool,
    tokens: estimatedTokens,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + reservationTtlMinutes * 60 * 1000).toISOString(),
  };
  document.pools[pool].reservedTokens += estimatedTokens;
  recomputePoolRemaining(document.pools[pool], limits[pool]);
}

function applyRelease(document, { callId }, limits) {
  const reservation = document.reservations[callId];
  if (!reservation) {
    return;
  }
  const pool = reservation.pool;
  if (pool === "premium" || pool === "mini") {
    document.pools[pool].reservedTokens = Math.max(
      0,
      document.pools[pool].reservedTokens - (reservation.tokens ?? 0),
    );
    recomputePoolRemaining(document.pools[pool], limits[pool]);
  }
  delete document.reservations[callId];
}

function applyCommit(document, {
  callId,
  model,
  usage,
  step,
  batchId,
}, limits) {
  if (document.committedCallIds.includes(callId)) {
    return false;
  }
  const parsed = parseOpenAIUsage(usage);
  if (!parsed) {
    applyRelease(document, { callId }, limits);
    return false;
  }

  const pool = classifyModelPool(model);
  applyRelease(document, { callId }, limits);

  if (pool === "premium" || pool === "mini") {
    document.pools[pool].usedTokens += parsed.totalTokens;
    document.pools[pool].calls += 1;
    recomputePoolRemaining(document.pools[pool], limits[pool]);
  }

  const modelBucket = document.models[model] ?? {
    pool,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  modelBucket.calls += 1;
  modelBucket.promptTokens += parsed.promptTokens;
  modelBucket.completionTokens += parsed.completionTokens;
  modelBucket.totalTokens += parsed.totalTokens;
  document.models[model] = modelBucket;

  const stepName = step ?? "unknown";
  const stepBucket = document.steps[stepName] ?? { calls: 0, totalTokens: 0 };
  stepBucket.calls += 1;
  stepBucket.totalTokens += parsed.totalTokens;
  document.steps[stepName] = stepBucket;

  const batchName = batchId ?? "unknown";
  const batchBucket = document.batches[batchName] ?? {
    calls: 0,
    premiumTokens: 0,
    miniTokens: 0,
    lastSeenAt: null,
  };
  batchBucket.calls += 1;
  if (pool === "premium") {
    batchBucket.premiumTokens += parsed.totalTokens;
  } else if (pool === "mini") {
    batchBucket.miniTokens += parsed.totalTokens;
  }
  batchBucket.lastSeenAt = new Date().toISOString();
  document.batches[batchName] = batchBucket;

  document.totals.calls += 1;
  document.totals.promptTokens += parsed.promptTokens;
  document.totals.completionTokens += parsed.completionTokens;
  document.totals.totalTokens += parsed.totalTokens;
  document.committedCallIds.push(callId);
  document.updatedAt = new Date().toISOString();
  return true;
}

function applyPaidUsage(document, {
  type,
  model,
  usage,
  audioSeconds = 0,
  step,
  batchId,
}) {
  document.pools.paidOther.calls += 1;
  if (type === "whisper") {
    document.pools.paidOther.audioSeconds += audioSeconds;
  } else {
    const parsed = parseOpenAIUsage(usage);
    document.pools.paidOther.inputTokens += parsed?.promptTokens ?? parsed?.totalTokens ?? 0;
  }

  const modelBucket = document.models[model] ?? {
    pool: "paidOther",
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  modelBucket.calls += 1;
  if (type === "embedding") {
    const parsed = parseOpenAIUsage(usage);
    modelBucket.promptTokens += parsed?.promptTokens ?? 0;
    modelBucket.totalTokens += parsed?.totalTokens ?? 0;
  }
  document.models[model] = modelBucket;

  const stepName = step ?? "unknown";
  const stepBucket = document.steps[stepName] ?? { calls: 0, totalTokens: 0 };
  stepBucket.calls += 1;
  document.steps[stepName] = stepBucket;

  const batchName = batchId ?? "unknown";
  const batchBucket = document.batches[batchName] ?? {
    calls: 0,
    premiumTokens: 0,
    miniTokens: 0,
    lastSeenAt: null,
  };
  batchBucket.calls += 1;
  batchBucket.lastSeenAt = new Date().toISOString();
  document.batches[batchName] = batchBucket;
  document.updatedAt = new Date().toISOString();
}

function maybeEmitWarnings(document, warnPercents, onWarn) {
  if (typeof onWarn !== "function") {
    return;
  }
  for (const poolName of ["premium", "mini"]) {
    const limit = document.limits[poolName];
    const used = document.pools[poolName].usedTokens;
    const percent = limit > 0 ? Math.floor((used / limit) * 100) : 0;
    for (const threshold of warnPercents) {
      if (percent >= threshold) {
        onWarn({
          pool: poolName,
          percent,
          threshold,
          usedTokens: used,
          limit,
          remainingTokens: document.pools[poolName].remainingTokens,
        });
      }
    }
  }
}

function withDailyDocument({
  usageDir,
  timezone,
  limits,
  reservePercent,
  reservationTtlMinutes,
  mutate,
}) {
  const date = formatQuotaDateKey(new Date(), timezone);
  const dailyDir = path.join(usageDir, "daily");
  const filePath = path.join(dailyDir, `${date}.json`);
  const lockPath = path.join(dailyDir, `${date}.lock`);
  const releaseLock = acquireDailyLock(lockPath);
  try {
    const document = readDailyDocument(filePath, { date, timezone, limits });
    cleanupExpiredReservations(document, limits, reservationTtlMinutes);
    const result = mutate(document);
    atomicWriteJson(filePath, document);
    return result;
  } finally {
    releaseLock();
  }
}

export function createDailyQuotaTracker({
  usageDir = process.env.OPENAI_USAGE_DIR ?? path.join("output", ".openai-usage"),
  timezone = process.env.OPENAI_QUOTA_TIMEZONE ?? "UTC",
  batchId = null,
  limits = {
    premium: Number(process.env.OPENAI_DAILY_PREMIUM_LIMIT ?? DEFAULT_PREMIUM_LIMIT),
    mini: Number(process.env.OPENAI_DAILY_MINI_LIMIT ?? DEFAULT_MINI_LIMIT),
  },
  reservePercent = Number(process.env.OPENAI_QUOTA_RESERVE_PERCENT ?? DEFAULT_RESERVE_PERCENT),
  reservationTtlMinutes = Number(process.env.OPENAI_QUOTA_RESERVATION_TTL_MINUTES ?? DEFAULT_RESERVATION_TTL_MINUTES),
  warnPercents = parseWarnPercents(process.env.OPENAI_USAGE_WARN_PERCENT),
} = {}) {
  /** @type {((warning: object) => void) | undefined} */
  let onWarn;

  const tracker = {
    get onWarn() {
      return onWarn;
    },
    set onWarn(handler) {
      onWarn = handler;
    },

    snapshot() {
      const date = formatQuotaDateKey(new Date(), timezone);
      const filePath = path.join(usageDir, "daily", `${date}.json`);
      return readDailyDocument(filePath, { date, timezone, limits });
    },

    reserve({
      callId = randomUUID(),
      role,
      step,
      model,
      estimatedTokens,
    }) {
      withDailyDocument({
        usageDir,
        timezone,
        limits,
        reservePercent,
        reservationTtlMinutes,
        mutate(document) {
          applyReserve(document, {
            callId,
            role,
            step,
            model,
            estimatedTokens,
            batchId,
            limits,
            reservePercent,
            reservationTtlMinutes,
          });
        },
      });
      return callId;
    },

    commit({
      callId,
      model,
      usage,
      step,
      batchId: eventBatchId,
    }) {
      let committed = false;
      withDailyDocument({
        usageDir,
        timezone,
        limits,
        reservePercent,
        reservationTtlMinutes,
        mutate(document) {
          committed = applyCommit(document, {
            callId,
            model,
            usage,
            step,
            batchId: eventBatchId ?? batchId,
          }, limits);
          maybeEmitWarnings(document, warnPercents, onWarn);
        },
      });
      return committed;
    },

    release({ callId, reason: _reason }) {
      withDailyDocument({
        usageDir,
        timezone,
        limits,
        reservePercent,
        reservationTtlMinutes,
        mutate(document) {
          applyRelease(document, { callId }, limits);
        },
      });
    },

    markPoolExhausted({ pool, reason: _reason }) {
      withDailyDocument({
        usageDir,
        timezone,
        limits,
        reservePercent,
        reservationTtlMinutes,
        mutate(document) {
          if (pool === "premium" || pool === "mini") {
            document.pools[pool].exhausted = true;
            document.pools[pool].remainingTokens = 0;
          }
          document.updatedAt = new Date().toISOString();
        },
      });
    },

    recordPaidUsage(event) {
      withDailyDocument({
        usageDir,
        timezone,
        limits,
        reservePercent,
        reservationTtlMinutes,
        mutate(document) {
          applyPaidUsage(document, {
            ...event,
            batchId: event.batchId ?? batchId,
          });
        },
      });
    },

    isPoolExhausted(pool) {
      const snapshot = tracker.snapshot();
      return Boolean(snapshot.pools?.[pool]?.exhausted);
    },
  };

  return tracker;
}

export function isQuotaTrackingEnabled(env = process.env) {
  return env.OPENAI_QUOTA_TRACKING === "1";
}

export function createDailyQuotaTrackerIfEnabled(options = {}) {
  if (!isQuotaTrackingEnabled(options.env ?? process.env)) {
    return null;
  }
  return createDailyQuotaTracker(options);
}

export function buildDailyQuotaWarnings(summary, {
  warnPercents = [70, 90, 100],
} = {}) {
  if (!summary?.pools) {
    return [];
  }
  const warnings = [];
  for (const poolName of ["premium", "mini"]) {
    const limit = summary.limits?.[poolName] ?? 0;
    const used = summary.pools?.[poolName]?.usedTokens ?? 0;
    if (limit <= 0) {
      continue;
    }
    const percent = Math.floor((used / limit) * 100);
    for (const threshold of warnPercents) {
      if (percent >= threshold) {
        warnings.push({
          severity: threshold >= 100 ? "critical" : "warning",
          code: "OPENAI_DAILY_QUOTA",
          message: `Pula ${poolName}: ${used}/${limit} tokenów (${percent}%, próg ${threshold}%)`,
          pool: poolName,
          percent,
          threshold,
        });
      }
    }
    if (summary.pools?.[poolName]?.exhausted) {
      warnings.push({
        severity: "critical",
        code: "OPENAI_POOL_EXHAUSTED",
        message: `Pula ${poolName} oznaczona jako wyczerpana`,
        pool: poolName,
      });
    }
  }
  return warnings;
}

export function readDailyQuotaSummary({
  usageDir = process.env.OPENAI_USAGE_DIR ?? path.join("output", ".openai-usage"),
  timezone = process.env.OPENAI_QUOTA_TIMEZONE ?? "UTC",
  date = new Date(),
  limits = {
    premium: Number(process.env.OPENAI_DAILY_PREMIUM_LIMIT ?? DEFAULT_PREMIUM_LIMIT),
    mini: Number(process.env.OPENAI_DAILY_MINI_LIMIT ?? DEFAULT_MINI_LIMIT),
  },
} = {}) {
  const dateKey = formatQuotaDateKey(date, timezone);
  const filePath = path.join(usageDir, "daily", `${dateKey}.json`);
  if (!fs.existsSync(filePath)) {
    return createEmptyDocument({ date: dateKey, timezone, limits });
  }
  return readDailyDocument(filePath, { date: dateKey, timezone, limits });
}

function parseExhaustedPools(raw) {
  if (!raw) {
    return [];
  }
  return String(raw)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value === "premium" || value === "mini");
}

function applyPoolSeed(document, poolName, {
  usedTokens,
  exhausted = false,
  limits,
  mode,
}) {
  const limit = limits[poolName];
  const pool = document.pools[poolName];
  let targetUsed = Math.max(0, usedTokens);
  if (exhausted && targetUsed === 0) {
    targetUsed = limit;
  }
  targetUsed = Math.min(targetUsed, limit);
  if (mode === "set") {
    pool.usedTokens = targetUsed;
  } else {
    pool.usedTokens = Math.max(pool.usedTokens ?? 0, targetUsed);
  }
  pool.calls = Math.max(pool.calls ?? 0, pool.usedTokens > 0 ? 1 : 0);
  if (exhausted || pool.usedTokens >= limit) {
    pool.exhausted = true;
    pool.remainingTokens = 0;
  }
  recomputePoolRemaining(pool, limit);
  if (pool.exhausted) {
    pool.remainingTokens = 0;
  }
}

/**
 * Seed daily quota with usage that happened before OPENAI_QUOTA_TRACKING was enabled.
 *
 * @param {{
 *   usageDir?: string,
 *   timezone?: string,
 *   limits?: { premium: number, mini: number },
 *   date?: Date,
 *   premiumUsedTokens?: number,
 *   miniUsedTokens?: number,
 *   exhaustedPools?: Array<"premium" | "mini">,
 *   note?: string,
 *   mode?: "set-minimum" | "set",
 * }} params
 */
export function seedDailyQuotaUsage({
  usageDir = process.env.OPENAI_USAGE_DIR ?? path.join("output", ".openai-usage"),
  timezone = process.env.OPENAI_QUOTA_TIMEZONE ?? "UTC",
  limits = {
    premium: Number(process.env.OPENAI_DAILY_PREMIUM_LIMIT ?? DEFAULT_PREMIUM_LIMIT),
    mini: Number(process.env.OPENAI_DAILY_MINI_LIMIT ?? DEFAULT_MINI_LIMIT),
  },
  date = new Date(),
  premiumUsedTokens = 0,
  miniUsedTokens = 0,
  exhaustedPools = [],
  note = "manual seed — usage before quota tracking",
  mode = "set-minimum",
} = {}) {
  const exhausted = new Set(exhaustedPools);
  let savedDocument = null;

  withDailyDocument({
    usageDir,
    timezone,
    limits,
    reservePercent: 0,
    reservationTtlMinutes: 0,
    mutate(document) {
      if (premiumUsedTokens > 0 || exhausted.has("premium")) {
        applyPoolSeed(document, "premium", {
          usedTokens: premiumUsedTokens,
          exhausted: exhausted.has("premium"),
          limits,
          mode,
        });
      }
      if (miniUsedTokens > 0 || exhausted.has("mini")) {
        applyPoolSeed(document, "mini", {
          usedTokens: miniUsedTokens,
          exhausted: exhausted.has("mini"),
          limits,
          mode,
        });
      }

      document.manualSeed = {
        note,
        mode,
        premiumUsedTokens,
        miniUsedTokens,
        exhaustedPools: [...exhausted],
        seededAt: new Date().toISOString(),
      };
      document.updatedAt = new Date().toISOString();
      savedDocument = document;
      return document;
    },
  });

  return savedDocument;
}

export function seedDailyQuotaUsageFromEnv(env = process.env) {
  const premiumRaw = env.OPENAI_QUOTA_SEED_PREMIUM;
  const miniRaw = env.OPENAI_QUOTA_SEED_MINI;
  const premiumUsedTokens = Number.parseInt(premiumRaw ?? "0", 10);
  const miniUsedTokens = Number.parseInt(miniRaw ?? "0", 10);
  const exhaustedPools = parseExhaustedPools(env.OPENAI_QUOTA_SEED_EXHAUSTED);
  const note = env.OPENAI_QUOTA_SEED_NOTE ?? "manual seed — usage before quota tracking";

  if (
    (!Number.isFinite(premiumUsedTokens) || premiumUsedTokens <= 0)
    && (!Number.isFinite(miniUsedTokens) || miniUsedTokens <= 0)
    && exhaustedPools.length === 0
  ) {
    return null;
  }

  return seedDailyQuotaUsage({
    usageDir: env.OPENAI_USAGE_DIR,
    timezone: env.OPENAI_QUOTA_TIMEZONE,
    premiumUsedTokens: Number.isFinite(premiumUsedTokens) ? premiumUsedTokens : 0,
    miniUsedTokens: Number.isFinite(miniUsedTokens) ? miniUsedTokens : 0,
    exhaustedPools,
    note,
  });
}
