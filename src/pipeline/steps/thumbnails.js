import path from "node:path";
import fs from "node:fs";
import { createOpenAIClient } from "../../agents/openai-client.js";
import {
  buildStubThumbnailPlan,
  runThumbnailStrategist,
} from "../../agents/thumbnail-strategist.js";
import { runThumbnailCritic } from "../../agents/thumbnail-critic.js";
import { shortlistThumbnailFrames } from "../../editorial/thumbnail-frame-score.js";
import { composeThumbnail } from "../../editorial/thumbnail-compose.js";
import { extractFrameAt } from "../../lib/ffmpeg.js";
import {
  readJson,
  writeJson,
  ARTIFACTS,
  thumbnailImagePath,
} from "../work-paths.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";
import { ThumbnailPlanSchema, ThumbnailReviewSchema } from "../../schemas/thumbnail-plan.js";
import { resolvePublishVoice } from "../../editorial/publish-voice.js";

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

function buildFrameShortlistByOutput({
  recipe,
  timelineIndex,
  abstraction,
  spatialIndex,
  audioIndex,
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
    });
  }
  return frameShortlistByOutput;
}

function resolveFaceBboxForVariant({ variant, frameShortlistByOutput, outputId, spatialIndex }) {
  const shortlist = frameShortlistByOutput[outputId] ?? [];
  const match = shortlist.find(
    (entry) => entry.sceneId === variant.sourceRef.sceneId
      && Math.abs(entry.timestampSec - variant.sourceRef.timestampSec) < 0.5,
  );
  if (match?.faceBbox) {
    return match.faceBbox;
  }

  const spatialScene = (spatialIndex?.scenes ?? []).find(
    (scene) => scene.sceneId === variant.sourceRef.sceneId,
  );
  const faceAnchor = (spatialScene?.anchors ?? []).find(
    (anchor) => anchor.type === "face" || anchor.label === "face",
  );
  return faceAnchor?.bbox ?? null;
}

async function renderThumbnailVariants({
  workDir,
  plan,
  manifest,
  timelineIndex,
  frameShortlistByOutput,
  spatialIndex,
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
        await composeThumbnail({
          framePath,
          headline: variant.style === "frame_only" ? "" : variant.headline,
          style: variant.style,
          format: outputPlan.format,
          outputPath: imagePath,
          faceBbox: resolveFaceBboxForVariant({
            variant,
            frameShortlistByOutput,
            outputId: outputPlan.outputId,
            spatialIndex,
          }),
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

  const frameShortlistByOutput = buildFrameShortlistByOutput({
    recipe,
    timelineIndex,
    abstraction,
    spatialIndex,
    audioIndex,
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
