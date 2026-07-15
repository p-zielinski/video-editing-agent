export const HOOK_PROMPT_MAX_LENGTH = 2400;

const VERTICAL_SAFE_ZONE_HINT = "Frame for vertical 9:16 safe zone; keep subject clear of top and bottom UI margins";

function findSceneSummaries(abstraction, hookScene) {
  const l1Scenes = Array.isArray(abstraction?.L1) ? abstraction.L1 : [];
  const l2Segments = Array.isArray(abstraction?.L2) ? abstraction.L2 : [];
  const sceneSummary = l1Scenes.find(
    (entry) => entry.sceneId === hookScene?.sceneId,
  );
  const segmentSummary = l2Segments.find(
    (entry) => entry.sceneIds?.includes(hookScene?.sceneId),
  );
  return { sceneSummary, segmentSummary };
}

function buildLegacyHookPrompt(abstraction, hookScene) {
  const { sceneSummary, segmentSummary } = findSceneSummaries(abstraction, hookScene);
  const storyContext = abstraction?.L3?.sessionSummary
    ?? abstraction?.L3?.narrativeArc
    ?? segmentSummary?.summary
    ?? "";
  const topics = (sceneSummary?.topics ?? segmentSummary?.topics ?? [])
    .slice(0, 3)
    .join(", ");
  const visualTarget = sceneSummary?.summary ?? segmentSummary?.summary ?? "";
  const parts = [
    "Create a dynamic cinematic opening transition for a vertical short-form video",
    "Use smooth motivated camera motion and preserve subject identity, lighting, and composition between the supplied start and end frames",
    VERTICAL_SAFE_ZONE_HINT,
  ];
  if (topics) {
    parts.push(`Themes: ${topics}`);
  }
  if (storyContext) {
    parts.push(`Story context: ${storyContext.slice(0, 300)}`);
  }
  if (visualTarget) {
    parts.push(`End naturally on this visual beat: ${visualTarget.slice(0, 240)}`);
  }
  parts.push("Single continuous shot, photorealistic, no captions, no logos, no generated text");
  return parts.join(". ").slice(0, HOOK_PROMPT_MAX_LENGTH);
}

function formatMustAvoid(mustAvoid = []) {
  const items = mustAvoid.filter(Boolean);
  if (items.length === 0) {
    return null;
  }
  return `Must avoid: ${items.join(", ")}`;
}

/**
 * Deterministically compile a Kling hook prompt from L3 brief and scene context.
 * Falls back to legacy prompt shape when brief is absent.
 */
export function compileHookPrompt({
  brief,
  abstraction,
  hookScene,
  continuity = {},
} = {}) {
  if (!brief) {
    return buildLegacyHookPrompt(abstraction, hookScene);
  }

  const { sceneSummary, segmentSummary } = findSceneSummaries(abstraction, hookScene);
  const topics = (sceneSummary?.topics ?? []).slice(0, 3).join(", ");
  const sceneBeat = sceneSummary?.summary ?? segmentSummary?.summary ?? "";
  const parts = [
    "Create a dynamic cinematic opening transition for a vertical short-form video",
    "Use smooth motivated camera motion and preserve subject identity, lighting, and composition between the supplied start and end frames",
    VERTICAL_SAFE_ZONE_HINT,
    `Narrative promise: ${brief.narrativePromise}`,
    `Contextual link: ${brief.contextualLink}`,
  ];

  if (brief.visualTone) {
    parts.push(`Visual tone: ${brief.visualTone}`);
  }
  if (topics) {
    parts.push(`Themes: ${topics}`);
  }
  if (sceneBeat) {
    parts.push(`End naturally on this visual beat: ${sceneBeat.slice(0, 240)}`);
  }
  if (brief.strategy === "intentionally_unexpected" && brief.unexpectedElement) {
    parts.push(
      `Introduce a narratively linked but non-obvious visual element: ${brief.unexpectedElement}. `
      + "Do not reveal facts, outcomes, or payoff spoilers",
    );
  }
  if (continuity?.previousSceneSummary) {
    parts.push(`Continuity from prior beat: ${continuity.previousSceneSummary.slice(0, 180)}`);
  }
  const mustAvoid = formatMustAvoid(brief.mustAvoid);
  if (mustAvoid) {
    parts.push(mustAvoid);
  }
  parts.push("Single continuous shot, photorealistic, no captions, no logos, no generated text");

  return parts.join(". ").slice(0, HOOK_PROMPT_MAX_LENGTH);
}
