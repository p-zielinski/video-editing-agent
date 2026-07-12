import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";
import {
  buildDirectorBrief,
  filterL1ForScenes,
  EDIT_RECIPE_V2_OUTPUT_SCHEMA,
} from "./director.js";
import { buildActTransitionHints } from "../editorial/act-transitions.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";
import { measureBriefPayload } from "../lib/brief-metrics.js";

function findNeighborL2Summaries(abstraction, segmentId) {
  const l2 = abstraction?.L2 ?? [];
  const index = l2.findIndex((entry) => entry.segmentId === segmentId);
  if (index < 0) {
    return [];
  }

  const neighbors = [];
  if (index > 0) {
    const prev = l2[index - 1];
    neighbors.push({
      segmentId: prev.segmentId,
      summary: prev.summary,
      relation: "previous",
    });
  }
  if (index < l2.length - 1) {
    const next = l2[index + 1];
    neighbors.push({
      segmentId: next.segmentId,
      summary: next.summary,
      relation: "next",
    });
  }
  return neighbors;
}

function filterAbstractionForSegment(abstraction, sceneIds) {
  const idSet = new Set(sceneIds);
  return {
    ...abstraction,
    L1: filterL1ForScenes(abstraction, sceneIds),
    L2: (abstraction.L2 ?? []).filter((segment) =>
      (segment.sceneIds ?? []).some((sceneId) => idSet.has(sceneId)),
    ),
  };
}

function filterTimelineForSegment(timelineIndex, sceneIds) {
  const idSet = new Set(sceneIds);
  const scenes = (timelineIndex.scenes ?? []).filter((scene) => idSet.has(scene.sceneId));
  const clipIds = new Set(scenes.map((scene) => scene.clipId));
  const clips = (timelineIndex.clips ?? []).filter((clip) => clipIds.has(clip.clipId));

  return {
    ...timelineIndex,
    clips,
    scenes,
  };
}

function buildSegmentRecipeSkeleton(context, superPlan) {
  const { timelineIndex, batchContext, requiredFormats } = context;
  const outputs = (requiredFormats ?? ["16:9", "9:16"]).map((format) => ({
    outputId: format === "16:9" ? "main_16x9" : "short_9x16",
    outputKind: format === "16:9" ? "main" : "short",
    format,
    timeline: [],
  }));

  return {
    batchId: timelineIndex.batchId,
    version: "2.2",
    batchContext: {
      ...batchContext,
      requiredFormats,
    },
    outputs,
    creativityProfile: superPlan.creativityProfile,
    narrativeProfile: superPlan.narrativeProfile,
    creativeMoments: [],
  };
}

/**
 * Segment-scoped director brief: segment scenes + L3 global + neighbor L2 one-liners.
 */
export function buildSegmentDirectorBrief(context, {
  segmentId,
  sceneIds,
  superPlan,
  superNotes = [],
}) {
  const {
    abstraction,
    timelineIndex,
    clipRegistry,
    topicIndex,
    spatialIndex,
    audioIndex,
    audioMixDefaults,
    musicSelection,
    musicBeatGrid,
    perClipAnalysis,
    wordIndexes,
    userContext,
    requiredFormats,
    batchContext,
    keyframesByClip,
    workDir,
    aiVideoArtifact,
  } = context;

  const scopedAbstraction = filterAbstractionForSegment(abstraction, sceneIds);
  const scopedTimeline = filterTimelineForSegment(timelineIndex, sceneIds);
  const scopedClipIds = new Set((scopedTimeline.clips ?? []).map((clip) => clip.clipId));
  const scopedWordIndexes = (wordIndexes ?? []).filter(
    (entry) => scopedClipIds.has(entry.clipId),
  );
  const segmentPick = superPlan.segmentPicks?.find((pick) => pick.segmentId === segmentId);
  const notes = [
    ...superNotes,
    ...(superPlan.crossSegmentNotes ?? []),
  ].filter(Boolean);

  const segmentUserContext = [
    userContext,
    `segment:${segmentId}`,
    notes.length ? `super_notes:${notes.join(" | ")}` : "",
    segmentPick?.targetKeepRatio != null
      ? `target_keep_ratio:${segmentPick.targetKeepRatio}`
      : "",
    superPlan.globalTheme ? `theme:${superPlan.globalTheme}` : "",
  ].filter(Boolean).join("\n");

  const recipeSkeleton = buildSegmentRecipeSkeleton(context, superPlan);

  const brief = buildDirectorBrief({
    abstraction: scopedAbstraction,
    timelineIndex: scopedTimeline,
    clipRegistry,
    topicIndex,
    spatialIndex,
    audioIndex,
    audioMixDefaults,
    musicSelection,
    musicBeatGrid,
    perClipAnalysis,
    wordIndexes: scopedWordIndexes,
    userContext: segmentUserContext,
    requiredFormats,
    batchContext,
    keyframesByClip,
    includeL1: false,
    creativityProfile: superPlan.creativityProfile,
    narrativeProfile: superPlan.narrativeProfile,
    recipe: recipeSkeleton,
    outputs: recipeSkeleton.outputs,
    targetDurationSec: segmentPick?.targetKeepRatio != null
      ? scopedTimeline.scenes?.reduce((sum, scene) => sum + (scene.durationSec ?? 0), 0)
        * segmentPick.targetKeepRatio
      : undefined,
    workDir,
    aiVideoArtifact: segmentId === superPlan.segmentOrder?.[0]
      ? aiVideoArtifact
      : null,
  });

  brief.sessionSummary = abstraction.L3;
  brief.segmentScope = {
    segmentId,
    sceneIds,
    neighborL2Summaries: findNeighborL2Summaries(abstraction, segmentId),
    superPlanSegmentOrder: superPlan.segmentOrder ?? [],
    shortsSources: superPlan.shortsSources ?? [],
    excludedClips: superPlan.excludedClips ?? [],
  };

  const segmentNarrativeProfile = superPlan.narrativeProfile?.segments?.find(
    (entry) => entry.l2SegmentId === segmentId,
  );
  if (segmentNarrativeProfile) {
    brief.segmentNarrativeProfile = segmentNarrativeProfile;
  }

  const segmentCreativityBudget = brief.creativityBudgetByL2Segment?.[segmentId];
  if (segmentCreativityBudget) {
    brief.creativityBudget = segmentCreativityBudget;
  }

  const actTransitionHints = buildActTransitionHints(
    abstraction,
    superPlan.narrativeProfile ?? brief.narrativeProfile,
    { recipe: recipeSkeleton, wordIndexes: scopedWordIndexes },
  ).filter((hint) => hint.l2SegmentId === segmentId);
  if (actTransitionHints.length > 0) {
    brief.actTransitionHints = actTransitionHints;
  }

  return brief;
}

export async function runSegmentDirector(client, context, {
  segmentId,
  sceneIds,
  superPlan,
  superNotes = [],
  onUsage,
}) {
  const {
    timelineIndex,
    clipRegistry = [],
    requiredFormats = ["16:9", "9:16"],
    batchContext = {},
  } = context;

  const system = loadPrompt("director", { version: "v2" });
  const brief = buildSegmentDirectorBrief(context, {
    segmentId,
    sceneIds,
    superPlan,
    superNotes,
  });

  const user = JSON.stringify({
    task: "segment_director_draft",
    brief,
    outputSchema: EDIT_RECIPE_V2_OUTPUT_SCHEMA,
  });

  const briefMetric = measureBriefPayload({
    task: "segment_director_draft",
    userJson: user,
    brief,
    segmentId,
  });

  const raw = await chatJson(client, {
    model: MODELS.segmentDirector,
    system,
    user,
    temperature: 0.45,
    onUsage,
  });

  raw.batchId = timelineIndex.batchId;
  raw.version = raw.version ?? "2.4";
  if (!raw.batchContext) {
    raw.batchContext = brief.batchContext;
  }
  raw.batchContext.requiredFormats = requiredFormats;
  raw.batchContext.inputMode = brief.inputMode;
  if (!raw.creativityProfile) {
    raw.creativityProfile = brief.creativityProfile;
  }
  if (!raw.shortsRetentionProfile && brief.shortsRetentionProfile) {
    raw.shortsRetentionProfile = brief.shortsRetentionProfile;
  }
  if (!raw.vlogRetentionProfile && brief.vlogRetentionProfile) {
    raw.vlogRetentionProfile = brief.vlogRetentionProfile;
  }
  if (!raw.narrativeProfile && brief.narrativeProfile) {
    raw.narrativeProfile = brief.narrativeProfile;
  }
  if (!raw.creativeMoments) {
    raw.creativeMoments = [];
  }
  if (!raw.clipRegistry || raw.clipRegistry.length === 0) {
    raw.clipRegistry = clipRegistry;
  }

  const recipe = EditRecipeV2Schema.parse(raw);
  return { recipe: { ...recipe, segmentId }, briefMetric };
}
