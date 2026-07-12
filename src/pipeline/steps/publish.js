import fs from "node:fs";
import path from "node:path";
import {
  readJson,
  writeJson,
  ARTIFACTS,
  thumbnailImagePath,
} from "../work-paths.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";
import { resolveChapterMarkersForOutput } from "../../editorial/chapter-hints.js";
import { formatDescriptionForVoice, resolvePublishVoice } from "../../editorial/publish-voice.js";
import { PublishPackageSchema } from "../../schemas/publish-package.js";
import { resolveBrandSafety } from "../../editorial/brand-safety-enrich.js";
import { sanitizeTextForSafety } from "../../lib/profanity-censor.js";

const MAX_TAGS = 15;
const SHORTS_CAPTION_STUB = "";

export function formatChapterTimestamp(startSec) {
  const total = Math.max(0, Math.floor(startSec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatChapterTimestamps(chapterMarkers = []) {
  return [...chapterMarkers]
    .sort((a, b) => a.startSec - b.startSec)
    .map((marker) => `${formatChapterTimestamp(marker.startSec)} ${marker.title}`.trim());
}

export function assemblePublishDescription(synopsis, chapterTimestamps = []) {
  const parts = [];
  if (synopsis?.trim()) {
    parts.push(synopsis.trim());
  }
  if (chapterTimestamps.length > 0) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(...chapterTimestamps);
  }
  return parts.join("\n");
}

function collectTopicTags(topicIndex) {
  const tags = new Set();
  for (const topic of topicIndex?.topics ?? []) {
    if (topic.label) {
      tags.add(String(topic.label).trim());
    }
    for (const keyword of topic.keywords ?? []) {
      if (keyword) {
        tags.add(String(keyword).trim());
      }
    }
  }
  return [...tags];
}

function collectTwelveLabsTags(workDir) {
  const tags = new Set();
  if (!fs.existsSync(workDir)) {
    return [];
  }

  for (const fileName of fs.readdirSync(workDir)) {
    if (!fileName.startsWith("03b-twelvelabs-") || !fileName.endsWith(".json")) {
      continue;
    }
    const artifact = readJson(path.join(workDir, fileName));
    for (const topic of artifact.gist?.topics ?? artifact.topics ?? []) {
      if (topic) {
        tags.add(String(topic).trim());
      }
    }
    for (const hashtag of artifact.gist?.hashtags ?? artifact.hashtags ?? []) {
      if (hashtag) {
        tags.add(String(hashtag).replace(/^#/, "").trim());
      }
    }
    for (const chapter of artifact.chapters ?? []) {
      if (chapter.title) {
        tags.add(String(chapter.title).trim());
      }
    }
    for (const moment of artifact.moments ?? []) {
      for (const tag of moment.tags ?? []) {
        if (tag) {
          tags.add(String(tag).trim());
        }
      }
    }
  }

  return [...tags];
}

export function resolvePublishTags({ topicIndex, workDir }) {
  const merged = new Set([
    ...collectTopicTags(topicIndex),
    ...collectTwelveLabsTags(workDir),
  ]);
  return [...merged].filter(Boolean).slice(0, MAX_TAGS);
}

function resolveThumbnailPlanOutput(thumbnailPlan, outputId) {
  return thumbnailPlan?.outputs?.find((output) => output.outputId === outputId) ?? null;
}

function resolveTitleVariants(thumbnailOutputPlan) {
  if (!thumbnailOutputPlan?.variants?.length) {
    return [];
  }
  const seen = new Set();
  const variants = [];
  for (const variant of thumbnailOutputPlan.variants) {
    const title = variant.titleVariant?.trim();
    if (!title || seen.has(title)) {
      continue;
    }
    seen.add(title);
    variants.push(title);
  }
  return variants;
}

function resolveThumbnailPath({ workDir, thumbnailOutputPlan, outputId }) {
  if (!thumbnailOutputPlan?.variants?.length) {
    return null;
  }

  const preferred = thumbnailOutputPlan.variants.find((variant) => variant.strategy === "safe")
    ?? thumbnailOutputPlan.variants[0];

  if (preferred.renderedPath && fs.existsSync(preferred.renderedPath)) {
    return preferred.renderedPath;
  }

  const fallbackPath = thumbnailImagePath(workDir, outputId, preferred.variantId);
  return fs.existsSync(fallbackPath) ? fallbackPath : null;
}

function resolveRenderOutput(renderManifest, outputId) {
  return renderManifest?.outputs?.find((output) => output.outputId === outputId) ?? null;
}

function allPublishPackagesCached(workDir, outputIds, force) {
  if (force) {
    return false;
  }
  return outputIds.length > 0 && outputIds.every(
    (outputId) => shouldUseCachedArtifact(workDir, ARTIFACTS.publishPackage(outputId), force),
  );
}

function loadOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

export function buildPublishPackageForOutput({
  recipe,
  output,
  thumbnailPlan,
  renderManifest,
  topicIndex,
  workDir,
  abstraction,
}) {
  const publishVoice = resolvePublishVoice({
    batchContext: recipe.batchContext ?? {},
  });
  const chapterMarkers = resolveChapterMarkersForOutput(output, { abstraction, recipe });
  const chapterTimestamps = formatChapterTimestamps(chapterMarkers);
  const synopsis = output.synopsis
    ? formatDescriptionForVoice(output.synopsis, publishVoice)
    : "";
  const description = assemblePublishDescription(synopsis, chapterTimestamps);
  const thumbnailOutputPlan = resolveThumbnailPlanOutput(thumbnailPlan, output.outputId);
  const renderOutput = resolveRenderOutput(renderManifest, output.outputId);
  const safety = resolveBrandSafety(recipe.batchContext ?? {});
  const safetyEnabled = safety.enabled !== false && safety.preset !== "off";
  const sanitize = (text, mode) => sanitizeTextForSafety(text, {
    mode,
    brandSafetyEnabled: safetyEnabled,
  });

  return PublishPackageSchema.parse({
    version: "1.0",
    batchId: recipe.batchId,
    outputId: output.outputId,
    format: output.format,
    outputKind: output.outputKind,
    title: sanitize(output.title, safety.titles),
    titleVariants: resolveTitleVariants(thumbnailOutputPlan)
      .map((title) => sanitize(title, safety.titles)),
    description: sanitize(description, safety.publishText),
    tags: resolvePublishTags({ topicIndex, workDir })
      .map((tag) => sanitize(tag, safety.publishText)),
    chapterTimestamps: chapterTimestamps
      .map((chapter) => sanitize(chapter, safety.publishText)),
    thumbnailPath: resolveThumbnailPath({
      workDir,
      thumbnailOutputPlan,
      outputId: output.outputId,
    }),
    videoPath: renderOutput?.outputPath ?? null,
    shortsCaption: output.outputKind === "short"
      ? sanitize(SHORTS_CAPTION_STUB, safety.publishText)
      : null,
  });
}

export async function runPublishStep({
  workDir,
  recipe,
  thumbnailPlan,
  renderManifest,
  topicIndex,
  abstraction,
  force = false,
}) {
  const resolvedRecipe = recipe
    ?? readJson(path.join(workDir, ARTIFACTS.recipeFinal));
  const outputIds = (resolvedRecipe.outputs ?? []).map((output) => output.outputId);

  if (allPublishPackagesCached(workDir, outputIds, force)) {
    const packages = {};
    for (const outputId of outputIds) {
      packages[outputId] = readJson(path.join(workDir, ARTIFACTS.publishPackage(outputId)));
    }
    return { packages };
  }

  const resolvedThumbnailPlan = thumbnailPlan
    ?? loadOptionalJson(path.join(workDir, ARTIFACTS.thumbnailPlan));
  const resolvedRenderManifest = renderManifest
    ?? loadOptionalJson(path.join(workDir, ARTIFACTS.renderManifest));
  const resolvedTopicIndex = topicIndex
    ?? loadOptionalJson(path.join(workDir, ARTIFACTS.topicIndex));
  const resolvedAbstraction = abstraction
    ?? loadOptionalJson(path.join(workDir, ARTIFACTS.abstraction));

  const packages = {};
  for (const output of resolvedRecipe.outputs ?? []) {
    const publishPackage = buildPublishPackageForOutput({
      recipe: resolvedRecipe,
      output,
      thumbnailPlan: resolvedThumbnailPlan,
      renderManifest: resolvedRenderManifest,
      topicIndex: resolvedTopicIndex,
      workDir,
      abstraction: resolvedAbstraction,
    });
    const outPath = path.join(workDir, ARTIFACTS.publishPackage(output.outputId));
    writeJson(outPath, publishPackage);
    packages[output.outputId] = publishPackage;
  }

  return { packages };
}
