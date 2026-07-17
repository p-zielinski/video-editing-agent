import {
  AbstractionBundleSchema,
  AbstractL1Schema,
  AbstractL2Schema,
} from "../schemas/edit-recipe.js";
import {
  chunkTimelineForL2,
  enrichSceneInputWithClipMeta,
  sceneSummaryInput,
} from "../lib/abstraction-chunking.js";
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
  isNarrationSource: "boolean — true gdy scena pochodzi z klipu narration_track lub audio_only z mową",
};

const L2_OUTPUT_SCHEMA = {
  segmentId: "string",
  startSec: "number",
  endSec: "number",
  sceneIds: ["string"],
  summary: "string",
  narrativeRole:
    "setup|development|tension|breath|climax|payoff|resolution|callback — rola segmentu w łuku fabularnym",
};

function buildClipHints(clipRegistry = []) {
  return clipRegistry.map((clip) => ({
    clipId: clip.clipId,
    clipRole: clip.clipRole,
    mediaType: clip.mediaType,
    hasSpeech: clip.hasSpeech,
  }));
}

function enrichSceneInput(scene, words, visionCaptions, clipRegistry, objectDetections = []) {
  const input = sceneSummaryInput(scene, words, visionCaptions, objectDetections);
  return enrichSceneInputWithClipMeta(input, clipRegistry);
}

function loadSummarizerPrompt() {
  const v2 = loadPrompt("summarizer", { version: "v2" });
  return v2 || loadPrompt("summarizer");
}

export function isSilentSceneInput(input) {
  return !input.transcript.trim() && !input.visual.trim();
}

export function groupScenesForL1Summarization(scenes, words, visionCaptions, {
  maxBatchSize = SILENT_BATCH_MAX_SCENES,
  clipRegistry = [],
  objectDetections = [],
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
    const input = enrichSceneInput(
      scene,
      words,
      visionCaptions,
      clipRegistry,
      objectDetections,
    );

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

export async function summarizeScene(client, sceneInput, { onUsage } = {}) {
  const system = loadSummarizerPrompt();
  const user = JSON.stringify({
    task: "L1_scene_summary",
    scene: sceneInput,
    outputSchema: L1_OUTPUT_SCHEMA,
  });

  return chatJson(client, { model: MODELS.summarizerL1, system, user, temperature: 0.3, onUsage });
}

export async function summarizeSceneBatch(client, scenesInputs, { onUsage } = {}) {
  const system = loadSummarizerPrompt();
  const user = JSON.stringify({
    task: "L1_batch_summary",
    scenes: scenesInputs,
    outputSchema: {
      scenes: [L1_OUTPUT_SCHEMA],
    },
  });

  const raw = await chatJson(client, { model: MODELS.summarizerL1, system, user, temperature: 0.3, onUsage });
  return Array.isArray(raw) ? raw : raw.scenes ?? [];
}

export async function summarizeSegment(client, segment, l1Summaries, { onUsage } = {}) {
  const system = loadSummarizerPrompt();
  const scenes = l1Summaries.filter((s) => segment.sceneIds.includes(s.sceneId));

  const user = JSON.stringify({
    task: "L2_segment_summary",
    segment,
    sceneSummaries: scenes,
    outputSchema: L2_OUTPUT_SCHEMA,
  });

  const raw = await chatJson(client, { model: MODELS.summarizerL2, system, user, temperature: 0.3, onUsage });
  return AbstractL2Schema.parse(raw);
}

export async function summarizeSession(client, {
  l2Summaries,
  userContext,
  stats,
  clipRegistry = [],
  audioQualitySummary = [],
  deliverySummary = [],
}, { onUsage } = {}) {
  const system = loadSummarizerPrompt();
  const user = JSON.stringify({
    task: "L3_session_summary",
    userContext,
    stats,
    clipHints: buildClipHints(clipRegistry),
    audioQualitySummary,
    deliverySummary,
    segmentSummaries: l2Summaries,
    outputSchema: {
      sessionSummary: "string",
      narrativeArc: "string",
      recommendedFormats: ["16:9", "9:16"],
      formatFit: { "16:9": "0-1", "9:16": "0-1" },
      estimatedKeepRatio: "0-1",
      hasSeparateNarration: "boolean — true gdy narracja nagrana osobno (narration_track / audio_only z mową, oddzielnie od B-roll)",
      editorialAssessment: {
        editabilityScore: "0-1 — jak łatwo złożyć dobry film z materiału",
        verdict: "strong|viable|salvageable|not_viable",
        storyCoherenceScore: "0-1 (opcjonalnie)",
        visualCoverageScore: "0-1 (opcjonalnie)",
        dialogueValueScore: "0-1 (opcjonalnie)",
        strengths: ["string"],
        constraints: ["weak_story|missing_context|weak_ending|insufficient_visuals|poor_dialogue_audio|excess_dead_air|repetitive_material|flat_delivery"],
        recommendedSalvageModes: ["voice_over|broll_montage|audio_enhancement|aggressive_trim|short_only|decline_output"],
        reasoning: "krótkie uzasadnienie po polsku",
      },
      deliveryAssessment: {
        verdict: "engaging|neutral|flat — prozodia i tempo mowy (nie jakość nagrania)",
        engagementScore: "0-1 (opcjonalnie)",
        blockingForRetention: "boolean — true gdy płaska prozodia blokuje retencję",
        recommendedRepairs: ["editorial_pacing|dsp_polish|localized_emphasis|filler_cuts|voice_resynthesis"],
        reasoning: "krótkie uzasadnienie po polsku",
      },
      openLoops: [{
        loopId: "loop_01",
        kind: "cold_open|payoff_tease|callback",
        setupSceneId: "sceneId setupu (opcjonalnie)",
        payoffSceneId: "sceneId payoffu (opcjonalnie)",
        teaseText: "krótki tekst zapowiedzi bez spoilera (opcjonalnie)",
      }],
      hookCreativeBrief: {
        strategy: "contextual|intentionally_unexpected",
        narrativePromise: "obietnica narracyjna hooka bez spoilera payoffu",
        contextualLink: "jak hook łączy się z materiałem bez ujawniania faktów",
        mustAvoid: ["spoilery", "logotypy", "napisy"],
        unexpectedElement: "wymagane gdy strategy=intentionally_unexpected — nieoczywisty, narracyjnie powiązany element wizualny",
        visualTone: "opcjonalny ton wizualny (np. napięcie, ciepło)",
      },
    },
  });

  return chatJson(client, { model: MODELS.summarizerL3, system, user, temperature: 0.3, onUsage });
}

function buildAudioQualitySummary(audioIndex) {
  if (!audioIndex?.clips?.length) {
    return [];
  }

  return audioIndex.clips.map((clip) => ({
    clipId: clip.clipId,
    voiceLufs: clip.voiceLufs ?? null,
    audioQualityGrade: clip.audioQualityGrade ?? null,
    audioQualityScore: clip.audioQualityScore ?? null,
    estimatedSnrDb: clip.estimatedSnrDb ?? null,
    windScore: clip.windScore ?? null,
    enhancementCandidateId: clip.enhancementCandidateId ?? null,
  }));
}

function buildDeliverySummary(audioIndex) {
  if (!audioIndex?.clips?.length) {
    return [];
  }

  return audioIndex.clips.map((clip) => ({
    clipId: clip.clipId,
    deliveryGrade: clip.deliveryGrade ?? null,
    deliveryScore: clip.deliveryScore ?? null,
    deliveryDominantIssues: clip.deliveryDominantIssues ?? [],
    flatDeliveryWindowCount: clip.flatDeliveryWindowCount ?? 0,
  }));
}

export async function buildAbstractionBundle(client, timelineIndex, {
  userContext = "",
  clipRegistry = [],
  audioIndex = null,
  onUsage,
} = {}) {
  const l1 = [];
  const groups = groupScenesForL1Summarization(
    timelineIndex.scenes,
    timelineIndex.words,
    timelineIndex.visionCaptions,
    {
      clipRegistry,
      objectDetections: timelineIndex.objectDetections ?? [],
    },
  );

  for (const group of groups) {
    if (group.type === "batch") {
      const summaries = await summarizeSceneBatch(client, group.inputs, { onUsage });
      for (const summary of summaries) {
        l1.push(AbstractL1Schema.parse(summary));
      }
    } else {
      const summary = await summarizeScene(client, group.input, { onUsage });
      l1.push(AbstractL1Schema.parse(summary));
    }
  }

  const segmentDefs = chunkTimelineForL2(timelineIndex.scenes, { clipRegistry });
  const l2 = [];

  for (const segment of segmentDefs) {
    const summary = await summarizeSegment(client, segment, l1, { onUsage });
    l2.push(AbstractL2Schema.parse(summary));
  }

  const l3 = await summarizeSession(client, {
    l2Summaries: l2,
    userContext: userContext || timelineIndex.userContext || "",
    stats: timelineIndex.stats,
    clipRegistry,
    audioQualitySummary: buildAudioQualitySummary(audioIndex),
    deliverySummary: buildDeliverySummary(audioIndex),
  }, { onUsage });

  return AbstractionBundleSchema.parse({
    version: "1.0",
    batchId: timelineIndex.batchId,
    L1: l1,
    L2: l2,
    L3: l3,
  });
}
