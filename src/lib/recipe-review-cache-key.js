import { createHash } from "node:crypto";

/**
 * Stable fingerprint for review LLM caches (critic / super_critic / fixer).
 * Changes when output shape or creative-moment density shifts materially.
 *
 * @param {object} recipe
 * @returns {string} short sha256 hex prefix
 */
export function buildRecipeReviewCacheKey(recipe) {
  const outputs = [...(recipe?.outputs ?? [])].sort((a, b) =>
    String(a.outputId).localeCompare(String(b.outputId)),
  );
  const outputIds = outputs.map((output) => output.outputId);
  const segmentCounts = outputs.map(
    (output) => `${output.outputId}:${(output.timeline ?? []).length}`,
  );
  const creativeMomentsCount = (recipe?.creativeMoments ?? []).length;
  const level = recipe?.creativityProfile?.level ?? "balanced";

  const payload = [
    outputIds.join(","),
    segmentCounts.join("|"),
    `moments:${creativeMomentsCount}`,
    `level:${level}`,
  ].join(";");

  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}
