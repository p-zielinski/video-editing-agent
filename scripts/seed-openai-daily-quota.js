#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import {
  formatQuotaDateKey,
  readDailyQuotaSummary,
  seedDailyQuotaUsage,
} from "../src/lib/openai-daily-usage.js";

function parseArgs(argv) {
  const options = {
    premium: null,
    mini: null,
    exhausted: [],
    note: "manual seed — usage before quota tracking",
    mode: "set-minimum",
    date: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--premium") {
      options.premium = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--mini") {
      options.mini = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--exhausted") {
      const value = String(argv[index + 1] ?? "").toLowerCase();
      if (value === "premium" || value === "mini") {
        options.exhausted.push(value);
      } else {
        for (const pool of value.split(",").map((part) => part.trim())) {
          if (pool === "premium" || pool === "mini") {
            options.exhausted.push(pool);
          }
        }
      }
      index += 1;
      continue;
    }
    if (arg === "--note") {
      options.note = argv[index + 1] ?? options.note;
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      const mode = argv[index + 1];
      if (mode === "set" || mode === "set-minimum") {
        options.mode = mode;
      }
      index += 1;
      continue;
    }
    if (arg === "--date") {
      options.date = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`Ustawia dzienne zużycie OpenAI sprzed włączenia OPENAI_QUOTA_TRACKING.

Użycie:
  node scripts/seed-openai-daily-quota.js --premium 250000 --exhausted premium
  node scripts/seed-openai-daily-quota.js --mini 120000

Opcje:
  --premium <tokens>     Zużyte tokeny w puli premium (gpt-5.4, gpt-4o, …)
  --mini <tokens>        Zużyte tokeny w puli mini (gpt-5.4-mini/nano, …)
  --exhausted <pool>     Oznacz pulę jako wyczerpaną: premium | mini | premium,mini
  --date YYYY-MM-DD      Dzień quota (domyślnie dziś wg OPENAI_QUOTA_TIMEZONE)
  --mode set-minimum     Nie obniża już policzonego zużycia (domyślnie)
  --mode set             Nadpisuje zużycie podaną wartością
  --note <text>          Notatka w pliku dziennego quota

Zmienne .env:
  OPENAI_QUOTA_SEED_PREMIUM
  OPENAI_QUOTA_SEED_MINI
  OPENAI_QUOTA_SEED_EXHAUSTED=premium,mini
  OPENAI_QUOTA_SEED_NOTE
`);
}

const options = parseArgs(process.argv);
if (options.help) {
  printHelp();
  process.exit(0);
}

const timezone = process.env.OPENAI_QUOTA_TIMEZONE ?? "UTC";
const premiumUsedTokens = Number.isFinite(options.premium)
  ? options.premium
  : Number.parseInt(process.env.OPENAI_QUOTA_SEED_PREMIUM ?? "0", 10);
const miniUsedTokens = Number.isFinite(options.mini)
  ? options.mini
  : Number.parseInt(process.env.OPENAI_QUOTA_SEED_MINI ?? "0", 10);
const exhaustedPools = options.exhausted.length > 0
  ? options.exhausted
  : String(process.env.OPENAI_QUOTA_SEED_EXHAUSTED ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value === "premium" || value === "mini");

if (
  (!Number.isFinite(premiumUsedTokens) || premiumUsedTokens <= 0)
  && (!Number.isFinite(miniUsedTokens) || miniUsedTokens <= 0)
  && exhaustedPools.length === 0
) {
  printHelp();
  process.exit(1);
}

const date = options.date ? new Date(`${options.date}T12:00:00.000Z`) : new Date();
const usageDir = process.env.OPENAI_USAGE_DIR ?? path.join("output", ".openai-usage");

seedDailyQuotaUsage({
  usageDir,
  timezone,
  date,
  premiumUsedTokens: Number.isFinite(premiumUsedTokens) ? premiumUsedTokens : 0,
  miniUsedTokens: Number.isFinite(miniUsedTokens) ? miniUsedTokens : 0,
  exhaustedPools,
  note: options.note,
  mode: options.mode,
});

const summary = readDailyQuotaSummary({ usageDir, timezone, date });
const dateKey = formatQuotaDateKey(date, timezone);
const filePath = path.join(usageDir, "daily", `${dateKey}.json`);

console.log(`Zapisano seed quota: ${filePath}`);
console.log(
  `premium: ${summary.pools.premium.usedTokens}/${summary.limits.premium}`
  + ` (remaining ${summary.pools.premium.remainingTokens}, exhausted=${summary.pools.premium.exhausted})`,
);
console.log(
  `mini: ${summary.pools.mini.usedTokens}/${summary.limits.mini}`
  + ` (remaining ${summary.pools.mini.remainingTokens}, exhausted=${summary.pools.mini.exhausted})`,
);
