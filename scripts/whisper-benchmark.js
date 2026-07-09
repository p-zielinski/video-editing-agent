#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatWhisperBenchmarkReport,
  runWhisperBenchmark,
  WHISPER_BENCHMARK_MODES,
} from "../src/lib/whisper-benchmark.js";
import { WHISPER_EDIT_PROMPT } from "../src/lib/transcribe.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    mode: "fixture",
    caseIds: [],
    category: null,
    outputPath: null,
    json: false,
    failOnRegression: false,
    includePending: true,
    prompt: WHISPER_EDIT_PROMPT,
    apiKey: process.env.OPENAI_API_KEY,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--mode") {
      options.mode = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--case") {
      options.caseIds.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--category") {
      options.category = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--output") {
      options.outputPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--fail-on-regression") {
      options.failOnRegression = true;
      continue;
    }

    if (arg === "--no-include-pending") {
      options.includePending = false;
      continue;
    }

    if (arg === "--api-key") {
      options.apiKey = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--prompt-file") {
      const promptPath = path.resolve(argv[index + 1]);
      options.prompt = fs.readFileSync(promptPath, "utf8").trim();
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!WHISPER_BENCHMARK_MODES.has(options.mode)) {
    throw new Error(`Invalid --mode ${options.mode}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/whisper-benchmark.js [options]

Options:
  --mode fixture|live|record     Benchmark mode (default: fixture)
  --case <caseId>                Repeatable case filter
  --category <category>          profanity | en-proper-nouns | meta-commands
  --output <path>                Write JSON report to file
  --json                         Print JSON report to stdout
  --fail-on-regression           Exit 1 when cases fail or are pending
  --no-include-pending           Omit pending cases from report
  --api-key <key>                OpenAI API key for live/record
  --prompt-file <path>           Custom Whisper prompt
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if ((options.mode === "live" || options.mode === "record") && !options.apiKey) {
    console.error("OPENAI_API_KEY is required for live/record mode");
    process.exit(2);
  }

  const report = await runWhisperBenchmark({
    repoRoot: REPO_ROOT,
    mode: options.mode,
    caseIds: options.caseIds.length ? options.caseIds : undefined,
    category: options.category ?? undefined,
    apiKey: options.apiKey,
    prompt: options.prompt,
    outputPath: options.outputPath,
    failOnRegression: options.failOnRegression,
    includePending: options.includePending,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatWhisperBenchmarkReport(report));
  }

  if (options.failOnRegression && (report.summary.fail > 0 || report.summary.pending > 0)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(3);
});
