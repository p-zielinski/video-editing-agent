import { SuperDirectorPlanSchema } from "../schemas/super-director-plan.js";
import { parseAgentSchema } from "../lib/llm-response-cache.js";
import {
  buildSegmentCatalog,
  rankSegmentsByUserContext,
  SUPER_DIRECTOR_MAX_SEGMENT_PICKS,
} from "../lib/segment-catalog.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";
import { measureBriefPayload, warnBriefPayloadIfLarge } from "../lib/brief-metrics.js";
import { buildAiHookBrief } from "./director.js";

const SUPER_DIRECTOR_OUTPUT_SCHEMA = {
  segmentOrder: ["seg001"],
  segmentPicks: [
    {
      segmentId: "seg001",
      priority: 1,
      targetKeepRatio: 0.4,
    },
  ],
  crossSegmentNotes: ["string"],
  crossSegmentCallbacks: [
    {
      callbackId: "cb_restaurant_echo",
      setupSceneId: "clip01_scene001",
      payoffSceneId: "clip01_scene010",
      teaseText: "Pamiętacie restaurację?",
    },
  ],
  shortsSources: ["seg001"],
  globalTheme: "string?",
  creativityProfile: {
    level: "safe|balanced|bold|shorts",
    allowMidSentenceCuts: false,
    techniquePack: "youtube_vlog_2026",
    maxTechniqueDensityPerMin: 0.3,
  },
  narrativeProfile: {
    mode: "internet_documentary|retention_vlog",
    segments: [
      {
        l2SegmentId: "seg001",
        rhythm: "slow|normal|fast",
        retentionIntensity: "low|medium|high",
        silencePolicy: "preserve|trim_dead_air|aggressive",
      },
    ],
    maxPatternInterruptsPer10Min: 1,
    sfxNarrativeOnly: true,
    silencePolicy: "preserve|trim_dead_air|aggressive",
  },
  excludedClips: ["clipId"],
};

export async function runSuperDirector(client, {
  abstraction,
  timelineIndex,
  clipRegistry = [],
  userContext = "",
  batchContext = {},
  requiredFormats = ["16:9", "9:16"],
  aiVideoArtifact = null,
  onUsage,
  quotaTracker,
  batchId,
  step,
  workDir = null,
}) {
  const catalog = buildSegmentCatalog(abstraction, timelineIndex, clipRegistry);
  const rankedSegmentHints = rankSegmentsByUserContext(userContext, catalog);
  const system = loadPrompt("super-director", { version: "v2" });

  const user = JSON.stringify({
    task: "super_director_route",
    segmentCatalog: catalog,
    sessionSummary: abstraction.L3,
    userContext: userContext || timelineIndex.userContext || "",
    batchContext: {
      ...batchContext,
      requiredFormats,
    },
    requiredFormats,
    rankedSegmentHints: rankedSegmentHints.map((card) => card.segmentId),
    maxSegmentPicks: SUPER_DIRECTOR_MAX_SEGMENT_PICKS,
    ...(buildAiHookBrief(aiVideoArtifact)
      ? { aiHook: buildAiHookBrief(aiVideoArtifact) }
      : {}),
    outputSchema: SUPER_DIRECTOR_OUTPUT_SCHEMA,
  });

  const briefMetric = measureBriefPayload({
    task: "super_director_route",
    userJson: user,
    meta: { segmentCatalogCount: catalog.length },
  });
  warnBriefPayloadIfLarge(briefMetric);

  const raw = await chatJson(client, {
    role: "superDirector",
    model: MODELS.superDirector,
    system,
    user,
    temperature: 0.35,
    onUsage,
    quotaTracker,
    batchId,
    step,
  });

  return {
    plan: parseAgentSchema(SuperDirectorPlanSchema, raw, {
      batchId,
      workDir,
      step: step ?? "super_director",
      role: "superDirector",
    }),
    briefMetric,
  };
}
