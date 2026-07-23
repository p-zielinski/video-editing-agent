import { chatJson, loadPrompt, MODELS } from "./openai-client.js";
import { buildRecipeReviewCacheKey } from "../lib/recipe-review-cache-key.js";
import { buildEditorialContext, spreadEditorialToPayload } from "../editorial/editorial-context.js";

/**
 * LLM cross-segment critic for super-director merged recipes.
 * Checks arc continuity, callbacks, cold-open payoff, stitch narrative gaps.
 */
export async function runSuperCritic(client, {
  recipe,
  superPlan,
  abstraction,
  partials = [],
  timelineIndex,
  topicIndex,
  spatialIndex,
  audioIndex,
  perClipAnalysis,
  wordIndexes,
  onUsage,
  quotaTracker,
  batchId,
  step,
  cacheKey = null,
  workDir = null,
}) {
  const system = loadPrompt("super-critic", { version: "v2" })
    || loadPrompt("super-critic");

  const editorialContext = buildEditorialContext({
    timelineIndex,
    recipe,
    audioIndex,
    topicIndex,
    spatialIndex,
    includeFullTopicIndex: false,
    perClipAnalysis,
    wordIndexes,
  });

  const userPayload = {
    task: "super_critic_cross_segment",
    recipe: {
      version: recipe.version,
      outputs: recipe.outputs,
      creativeMoments: recipe.creativeMoments,
      textOverlays: recipe.outputs?.flatMap((o) => o.textOverlays ?? []) ?? [],
      narrativeProfile: recipe.narrativeProfile,
      batchContext: recipe.batchContext,
    },
    superPlan: {
      segmentOrder: superPlan.segmentOrder,
      segmentPicks: superPlan.segmentPicks,
      crossSegmentNotes: superPlan.crossSegmentNotes ?? [],
      crossSegmentCallbacks: superPlan.crossSegmentCallbacks ?? [],
      globalTheme: superPlan.globalTheme,
    },
    partialSegmentIds: partials.map((p) => p.segmentId).filter(Boolean),
    sessionSummary: abstraction?.L3,
    segmentSummaries: abstraction?.L2 ?? [],
    stitchValidation: recipe.stitchValidation ?? null,
    outputSchema: {
      approved: "boolean",
      issues: [{
        severity: "error|warning|suggestion",
        code: "string",
        message: "string",
        segmentId: "string?",
      }],
      summary: "string",
      crossSegmentNotes: ["string"],
    },
  };

  spreadEditorialToPayload(userPayload, editorialContext);

  const raw = await chatJson(client, {
    role: "superCritic",
    model: MODELS.critic,
    system,
    user: JSON.stringify(userPayload),
    temperature: 0.2,
    onUsage,
    quotaTracker,
    batchId,
    step,
    cacheKey: cacheKey ?? buildRecipeReviewCacheKey(recipe),
    workDir,
  });

  const issues = raw.issues ?? [];
  const errors = issues.filter((issue) => issue.severity === "error");

  return {
    approved: raw.approved !== false && errors.length === 0,
    issues,
    summary: raw.summary ?? "",
    crossSegmentNotes: raw.crossSegmentNotes ?? [],
    raw,
  };
}
