import { SuperDirectorPlanSchema } from "../schemas/super-director-plan.js";
import {
  buildSegmentCatalog,
  rankSegmentsByUserContext,
  SUPER_DIRECTOR_MAX_SEGMENT_PICKS,
} from "../lib/segment-catalog.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";

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
  shortsSources: ["seg001"],
  globalTheme: "string?",
  creativityProfile: {
    level: "safe|balanced|bold|shorts",
    allowMidSentenceCuts: false,
    techniquePack: "youtube_vlog_2026",
    maxTechniqueDensityPerMin: 0.3,
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
    outputSchema: SUPER_DIRECTOR_OUTPUT_SCHEMA,
  });

  const raw = await chatJson(client, {
    model: MODELS.director,
    system,
    user,
    temperature: 0.35,
  });

  return SuperDirectorPlanSchema.parse(raw);
}
