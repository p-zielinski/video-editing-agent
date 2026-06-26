import { AbstractionBundleSchema, AbstractL1Schema } from "../schemas/edit-recipe.js";
import { chunkTimelineForL2, sceneSummaryInput } from "../lib/abstraction-chunking.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";

const SILENT_BATCH_MAX_SCENES = 8;

const L1_OUTPUT_SCHEMA = {
  sceneId: "string",
  summary: "30-80 słów po polsku",
  mood: "string",
  keyMoments: ["string"],
  brollPotential: "0-1 (potencjał B-roll)",
  topics: ["tagi wizualne/tematyczne"],
  visualQuality: "low|medium|high",
  stability: "stable|shaky|unknown",
};

function loadSummarizerPrompt() {
  const v2 = loadPrompt("summarizer", { version: "v2" });
  return v2 || loadPrompt("summarizer");
}

export function isSilentSceneInput(input) {
  return !input.transcript.trim() && !input.visual.trim();
}

export function groupScenesForL1Summarization(scenes, words, visionCaptions, {
  maxBatchSize = SILENT_BATCH_MAX_SCENES,
} = {}) {
  const groups = [];
  let silentBatch = null;

  const flushSilentBatch = () => {
    if (silentBatch) {
      groups.push(silentBatch);
      silentBatch = null;
    }
  };

  for (const scene of scenes) {
    const input = sceneSummaryInput(scene, words, visionCaptions);

    if (isSilentSceneInput(input)) {
      if (!silentBatch) {
        silentBatch = { type: "batch", inputs: [input] };
      } else {
        silentBatch.inputs.push(input);
        if (silentBatch.inputs.length >= maxBatchSize) {
          flushSilentBatch();
        }
      }
    } else {
      flushSilentBatch();
      groups.push({ type: "single", input });
    }
  }

  flushSilentBatch();
  return groups;
}

export async function summarizeScene(client, sceneInput) {
  const system = loadSummarizerPrompt();
  const user = JSON.stringify({
    task: "L1_scene_summary",
    scene: sceneInput,
    outputSchema: L1_OUTPUT_SCHEMA,
  });

  return chatJson(client, { model: MODELS.summarizer, system, user, temperature: 0.3 });
}

export async function summarizeSceneBatch(client, scenesInputs) {
  const system = loadSummarizerPrompt();
  const user = JSON.stringify({
    task: "L1_batch_summary",
    scenes: scenesInputs,
    outputSchema: {
      scenes: [L1_OUTPUT_SCHEMA],
    },
  });

  const raw = await chatJson(client, { model: MODELS.summarizer, system, user, temperature: 0.3 });
  return Array.isArray(raw) ? raw : raw.scenes ?? [];
}

export async function summarizeSegment(client, segment, l1Summaries) {
  const system = loadSummarizerPrompt();
  const scenes = l1Summaries.filter((s) => segment.sceneIds.includes(s.sceneId));

  const user = JSON.stringify({
    task: "L2_segment_summary",
    segment,
    sceneSummaries: scenes,
    outputSchema: {
      segmentId: "string",
      startSec: "number",
      endSec: "number",
      sceneIds: ["string"],
      summary: "string",
    },
  });

  return chatJson(client, { model: MODELS.summarizer, system, user, temperature: 0.3 });
}

export async function summarizeSession(client, { l2Summaries, userContext, stats }) {
  const system = loadSummarizerPrompt();
  const user = JSON.stringify({
    task: "L3_session_summary",
    userContext,
    stats,
    segmentSummaries: l2Summaries,
    outputSchema: {
      sessionSummary: "string",
      narrativeArc: "string",
      recommendedFormats: ["16:9", "9:16"],
      estimatedKeepRatio: "0-1",
    },
  });

  return chatJson(client, { model: MODELS.summarizer, system, user, temperature: 0.3 });
}

export async function buildAbstractionBundle(client, timelineIndex, { userContext = "" } = {}) {
  const l1 = [];
  const groups = groupScenesForL1Summarization(
    timelineIndex.scenes,
    timelineIndex.words,
    timelineIndex.visionCaptions,
  );

  for (const group of groups) {
    if (group.type === "batch") {
      const summaries = await summarizeSceneBatch(client, group.inputs);
      for (const summary of summaries) {
        l1.push(AbstractL1Schema.parse(summary));
      }
    } else {
      const summary = await summarizeScene(client, group.input);
      l1.push(AbstractL1Schema.parse(summary));
    }
  }

  const segmentDefs = chunkTimelineForL2(timelineIndex.scenes);
  const l2 = [];

  for (const segment of segmentDefs) {
    const summary = await summarizeSegment(client, segment, l1);
    l2.push(summary);
  }

  const l3 = await summarizeSession(client, {
    l2Summaries: l2,
    userContext: userContext || timelineIndex.userContext || "",
    stats: timelineIndex.stats,
  });

  return AbstractionBundleSchema.parse({
    version: "1.0",
    batchId: timelineIndex.batchId,
    L1: l1,
    L2: l2,
    L3: l3,
  });
}
