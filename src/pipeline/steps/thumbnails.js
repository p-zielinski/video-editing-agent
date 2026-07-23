import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { createOpenAIClient } from "../../agents/openai-client.js";
import {
  buildStubThumbnailPlan,
  runThumbnailStrategist,
} from "../../agents/thumbnail-strategist.js";
import { runThumbnailCritic } from "../../agents/thumbnail-critic.js";
import { shortlistThumbnailFrames } from "../../editorial/thumbnail-frame-score.js";
import {
  composeThumbnail,
  resolveSubjectBboxNearTimestamp,
} from "../../editorial/thumbnail-compose.js";
import { extractFrameAt } from "../../lib/ffmpeg.js";
import {
  readJson,
  writeJson,
  ARTIFACTS,
  thumbnailImagePath,
} from "../work-paths.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";
import { ThumbnailPlanSchema, ThumbnailReviewSchema } from "../../schemas/thumbnail-plan.js";
import { buildAgentChatContext } from "../../lib/gpt-usage-log.js";
import { resolvePublishVoice } from "../../editorial/publish-voice.js";
import {
  collectFaceDetections,
  loadCatalogForFaceDetect,
} from "./face-detect.js";
import {
  collectObjectDetections,
  mergeDetections,
} from "./spatial-index.js";

function resolveOpenAIClient({ apiKey, openaiClient }) {
  if (openaiClient) {
    return openaiClient;
  }
  return createOpenAIClient(apiKey);
}

function loadManifest(workDir) {
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  if (!fs.existsSync(manifestPath)) {
    return { clips: [] };
  }
  return readJson(manifestPath);
}

function resolveClipSourcePath({ manifest, timelineIndex, clipId }) {
  const manifestClip = manifest.clips?.find((clip) => clip.clipId === clipId);
  if (manifestClip?.sourcePath) {
    return manifestClip.sourcePath;
  }
  const timelineClip = timelineIndex.clips?.find((clip) => clip.clipId === clipId);
  return timelineClip?.sourcePath ?? null;
}

function groupDetectionsByClip(detections = []) {
  const byClip = {};
  for (const detection of detections) {
    const clipId = detection.clipId
      ?? (detection.sceneId ? String(detection.sceneId).replace(/_scene\d+$/i, "") : null);
    if (!clipId) {
      continue;
    }
    if (!byClip[clipId]) {
      byClip[clipId] = [];
    }
    byClip[clipId].push(detection);
  }
  return byClip;
}

function loadDetectionsByClip(workDir, timelineIndex) {
  const catalog = loadCatalogForFaceDetect(workDir, null, timelineIndex);
  const faces = collectFaceDetections(workDir, catalog);
  const objects = collectObjectDetections(workDir, catalog);
  return groupDetectionsByClip(mergeDetections(objects, faces));
}

function buildFrameShortlistByOutput({
  recipe,
  timelineIndex,
  abstraction,
  spatialIndex,
  audioIndex,
  detectionsByClip = {},
}) {
  const frameShortlistByOutput = {};
  for (const output of recipe.outputs ?? []) {
    frameShortlistByOutput[output.outputId] = shortlistThumbnailFrames({
      recipe,
      timelineIndex,
      abstraction,
      spatialIndex,
      audioIndex,
      outputId: output.outputId,
      detectionsByClip,
    });
  }
  return frameShortlistByOutput;
}

function resolveSubjectBboxForVariant({
  variant,
  frameShortlistByOutput,
  outputId,
  spatialIndex,
  detectionsByClip = {},
  srcWidth,
  srcHeight,
}) {
  const shortlist = frameShortlistByOutput[outputId] ?? [];
  const match = shortlist.find(
    (entry) => entry.sceneId === variant.sourceRef.sceneId
      && Math.abs(entry.timestampSec - variant.sourceRef.timestampSec) < 0.5,
  );
  if (match?.subjectBbox) {
    return match.subjectBbox;
  }
  if (match?.faceBbox) {
    return match.faceBbox;
  }

  const detections = detectionsByClip[variant.sourceRef.clipId] ?? [];
  const fromDetections = resolveSubjectBboxNearTimestamp({
    detections,
    timestampSec: variant.sourceRef.timestampSec,
    srcWidth,
    srcHeight,
    sceneId: variant.sourceRef.sceneId,
  });
  if (fromDetections) {
    return fromDetections;
  }

  const spatialScene = (spatialIndex?.scenes ?? []).find(
    (scene) => scene.sceneId === variant.sourceRef.sceneId,
  );
  const subjectAnchor = (spatialScene?.anchors ?? []).find(
    (anchor) => anchor.type === "subject" || String(anchor.label ?? "").toLowerCase().includes("dog"),
  ) ?? (spatialScene?.anchors ?? []).find(
    (anchor) => anchor.type === "face" || anchor.label === "face",
  );
  return subjectAnchor?.bbox ?? null;
}

async function renderThumbnailVariants({
  workDir,
  plan,
  manifest,
  timelineIndex,
  frameShortlistByOutput,
  spatialIndex,
  detectionsByClip = {},
  renderImages,
}) {
  if (!renderImages) {
    return { plan, renderWarnings: [] };
  }

  const renderWarnings = [];
  const outputs = [];
  for (const outputPlan of plan.outputs) {
    const variants = [];
    for (const variant of outputPlan.variants) {
      const sourcePath = resolveClipSourcePath({
        manifest,
        timelineIndex,
        clipId: variant.sourceRef.clipId,
      });
      const imagePath = thumbnailImagePath(workDir, outputPlan.outputId, variant.variantId);
      const frameCacheDir = path.join(workDir, "thumbnails", ".frames");
      fs.mkdirSync(frameCacheDir, { recursive: true });
      const framePath = path.join(
        frameCacheDir,
        `${variant.sourceRef.clipId}_${variant.sourceRef.timestampSec}.jpg`,
      );

      if (sourcePath && fs.existsSync(sourcePath)) {
        if (!fs.existsSync(framePath)) {
          await extractFrameAt(sourcePath, variant.sourceRef.timestampSec, framePath);
        }
        const frameMeta = await sharp(framePath).metadata();
        const subjectBbox = resolveSubjectBboxForVariant({
          variant,
          frameShortlistByOutput,
          outputId: outputPlan.outputId,
          spatialIndex,
          detectionsByClip,
          srcWidth: frameMeta.width ?? 1080,
          srcHeight: frameMeta.height ?? 1920,
        });
        await composeThumbnail({
          framePath,
          headline: variant.style === "frame_only" ? "" : variant.headline,
          style: variant.style,
          format: outputPlan.format,
          outputPath: imagePath,
          subjectBbox,
          faceBbox: subjectBbox,
        });
        variants.push({ ...variant, renderedPath: imagePath });
      } else {
        renderWarnings.push({
          severity: "warning",
          code: "render_skipped_missing_source",
          message: `Brak pliku źródłowego dla ${variant.sourceRef.clipId} — pominięto render ${variant.variantId}`,
          outputId: outputPlan.outputId,
          variantId: variant.variantId,
        });
        variants.push(variant);
      }
    }
    outputs.push({ ...outputPlan, variants });
  }

  return {
    plan: ThumbnailPlanSchema.parse({ ...plan, outputs }),
    renderWarnings,
  };
}

export async function runThumbnailsStep({
  workDir,
  apiKey,
  openaiClient,
  force = false,
  thumbnailStub = false,
  renderImages = true,
  gptUsageTracker,
  dailyQuotaTracker,
  batchId,
}) {
  const planPath = path.join(workDir, ARTIFACTS.thumbnailPlan);
  const reviewPath = path.join(workDir, ARTIFACTS.thumbnailReview);

  if (shouldUseCachedArtifact(workDir, ARTIFACTS.thumbnailPlan, force)
    && shouldUseCachedArtifact(workDir, ARTIFACTS.thumbnailReview, force)) {
    return {
      plan: readJson(planPath),
      review: readJson(reviewPath),
    };
  }

  const recipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
  const timelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
  const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
  const spatialIndex = readJson(path.join(workDir, ARTIFACTS.spatialIndex));
  const audioIndex = readJson(path.join(workDir, ARTIFACTS.audioIndex));
  const manifest = loadManifest(workDir);
  const publishVoice = resolvePublishVoice({
    batchContext: recipe.batchContext ?? manifest.batchContext ?? {},
    userContext: manifest.userContext ?? "",
  });

  const detectionsByClip = loadDetectionsByClip(workDir, timelineIndex);

  const frameShortlistByOutput = buildFrameShortlistByOutput({
    recipe,
    timelineIndex,
    abstraction,
    spatialIndex,
    audioIndex,
    detectionsByClip,
  });

  let plan;
  if (thumbnailStub) {
    plan = buildStubThumbnailPlan({ recipe, frameShortlistByOutput, publishVoice });
  } else {
    const client = resolveOpenAIClient({ apiKey, openaiClient });
    plan = await runThumbnailStrategist(client, {
      recipe,
      frameShortlist: frameShortlistByOutput,
      abstractionL3: abstraction.L3 ?? abstraction,
      userContext: manifest.userContext ?? "",
      publishVoice,
      ...buildAgentChatContext({
        gptUsageTracker,
        dailyQuotaTracker,
        batchId: batchId ?? recipe.batchId,
        step: "thumbnail_strategist",
      }),
    });
  }

  let review;
  if (thumbnailStub) {
    review = ThumbnailReviewSchema.parse({
      version: "1.0",
      batchId: recipe.batchId,
      approved: true,
      issues: [],
      suggestions: [],
      summary: "Stub: pominięto krytyka miniatur",
    });
  } else {
    const client = resolveOpenAIClient({ apiKey, openaiClient });
    const criticResult = await runThumbnailCritic(client, {
      thumbnailPlan: plan,
      recipe,
      abstractionL3: abstraction.L3 ?? abstraction,
      frameShortlist: frameShortlistByOutput,
      publishVoice,
      ...buildAgentChatContext({
        gptUsageTracker,
        dailyQuotaTracker,
        batchId: batchId ?? recipe.batchId,
        step: "thumbnail_critic",
      }),
    });
    review = criticResult.review;
    plan = criticResult.plan;
  }

  const renderResult = await renderThumbnailVariants({
    workDir,
    plan,
    manifest,
    timelineIndex,
    frameShortlistByOutput,
    spatialIndex,
    detectionsByClip,
    renderImages: renderImages && !thumbnailStub,
  });
  plan = renderResult.plan;
  if (renderResult.renderWarnings.length > 0) {
    review = {
      ...review,
      issues: [...(review.issues ?? []), ...renderResult.renderWarnings],
      approved: review.approved && !renderResult.renderWarnings.some((w) => w.severity === "error"),
    };
  }

  writeJson(planPath, plan);
  writeJson(reviewPath, review);

  return { plan, review };
}
