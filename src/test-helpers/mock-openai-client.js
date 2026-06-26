import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MINI_DAY_FIXTURES = path.join(REPO_ROOT, "fixtures", "batches", "mini-day");

function loadMiniDayFixture(fileName) {
  return JSON.parse(fs.readFileSync(path.join(MINI_DAY_FIXTURES, fileName), "utf8"));
}

/**
 * OpenAI-compatible client that dequeues JSON object responses.
 * @param {unknown[]} responses
 * @param {{ captureRequests?: boolean }} [options]
 */
export function createMockOpenAIClient(responses, { captureRequests = false } = {}) {
  const queue = [...responses];
  const requests = [];

  const client = {
    chat: {
      completions: {
        create: async (options) => {
          if (captureRequests) {
            requests.push(options);
          }
          const next = queue.shift();
          if (next === undefined) {
            throw new Error("Mock OpenAI client: brak kolejnej odpowiedzi w kolejce");
          }
          if (next instanceof Error) {
            throw next;
          }
          return {
            choices: [{ message: { content: JSON.stringify(next) } }],
          };
        },
      },
    },
  };

  if (captureRequests) {
    client.getCapturedRequests = () => requests;
    client.remainingResponses = () => queue.length;
  }

  return client;
}

/**
 * L1/L2/L3 summarizer payloads aligned with mini-day timeline.
 */
export function buildMiniDaySummarizerResponses() {
  const abstract = loadMiniDayFixture("06-abstract.json");

  const l2 = {
    segmentId: "seg001",
    startSec: 0,
    endSec: 45,
    sceneIds: ["clip01_scene001", "clip01_scene002", "clip02_scene001"],
    summary: "Vlog o restauracji — rozmowa A-roll i B-roll jedzenia we wnętrzu lokalu.",
  };

  return [
    abstract.L1.find((entry) => entry.sceneId === "clip01_scene001"),
    abstract.L1.find((entry) => entry.sceneId === "clip01_scene002"),
    abstract.L1.find((entry) => entry.sceneId === "clip02_scene001"),
    l2,
    abstract.L3,
  ];
}

/**
 * Valid EditRecipe v2 draft for mini-day (passes validateRecipeV2 with fixture indexes).
 */
export function buildMiniDayRecipeDraft() {
  return structuredClone(loadMiniDayFixture("expected-recipe-v2.json"));
}

/**
 * Recipe missing 9:16 output — triggers MISSING_REQUIRED_FORMAT in critic heuristics.
 */
export function buildMiniDayInvalidRecipeDraft() {
  const draft = buildMiniDayRecipeDraft();
  draft.outputs = draft.outputs.filter((output) => output.format === "16:9");
  return draft;
}

/**
 * Queued LLM responses for abstract → direct → review on mini-day.
 * @param {{ criticApproves?: boolean }} [options]
 */
export function buildMiniDayAgentLoopResponses({ criticApproves = true } = {}) {
  const summarizer = buildMiniDaySummarizerResponses();
  const validRecipe = buildMiniDayRecipeDraft();
  const invalidRecipe = buildMiniDayInvalidRecipeDraft();

  if (criticApproves) {
    return [
      ...summarizer,
      validRecipe,
      validRecipe,
      { approved: true, issues: [], summary: "Receptura spełnia wymagania formatów i rejestru scen." },
    ];
  }

  return [
    ...summarizer,
    invalidRecipe,
    invalidRecipe,
    {
      approved: false,
      issues: [{ severity: "error", code: "MISSING_REQUIRED_FORMAT", message: "Brak wyjścia 9:16" }],
      summary: "Wymagany format pionowy.",
    },
    validRecipe,
  ];
}

/**
 * Factory: mock client preloaded for mini-day agent loop E2E.
 * @param {{ criticApproves?: boolean, captureRequests?: boolean }} [options]
 */
export function createMiniDayMockClient({ criticApproves = true, captureRequests = false } = {}) {
  return createMockOpenAIClient(buildMiniDayAgentLoopResponses({ criticApproves }), {
    captureRequests,
  });
}
