import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveFfmpegBins } from "../lib/ffmpeg-bin.js";
import { probeDuration } from "../lib/ffmpeg.js";
import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";
import {
  ARTIFACTS,
  readJson,
  renderOutputPath,
  renderTmpDir,
  writeJson,
} from "../pipeline/work-paths.js";
import { resolveRenderContext } from "./resolve-render-context.js";
import { buildRenderEdl } from "./build-render-edl.js";
import { renderSegmentToFile, segmentTempPath, buildSegmentFfmpegArgs } from "./ffmpeg-segment.js";
import {
  concatSegmentFiles,
  cleanupTempDir,
  resolvePostConcatCreativeMoments,
} from "./ffmpeg-concat.js";
import { realignEdlAfterBeatSnaps } from "./realign-edl-beat-snaps.js";
import {
  resolveEncodeProfile,
  resolveOutputDimensions,
  resolveStylePresets,
} from "./render-config.js";
import { applyCreativeMoments } from "./ffmpeg-creative.js";
import { burnAssSubtitles } from "./ass-subtitles.js";
import { applyTextOverlays } from "./ffmpeg-graphics.js";
import { applyAudioMix, hasAudioMixMoments, outputHasAudioCensorship } from "./audio-mix.js";
import { applyColorGrade, shouldApplyColorGrade } from "./color-grade.js";
import { shouldAllowColorGrade } from "../editorial/color-grade-policy.js";
import { validateRenderFidelity } from "../validators/render-fidelity.js";
import {
  normalizeFromPass,
  shouldRunPass,
  resolveResumeStart,
  loadSegmentPaths,
  PASS_FILES,
} from "./render-resume.js";
import {
  collectFidelityCliWarnings,
  recordOutputFidelity,
} from "./montage-fidelity.js";

const SPATIAL_INDEX_FILE = "05c-spatial-index.json";

function assertRenderFidelity(recipe, options = {}) {
  const issues = validateRenderFidelity(recipe, { qualityProfile: "production" });
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0 && !options.allowRenderWarnings) {
    const summary = errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
    throw new Error(`Render fidelity check failed: ${summary}`);
  }
  return issues;
}

export function isFfmpegAvailable() {
  const { ffmpeg } = resolveFfmpegBins();
  const result = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
  return result.status === 0;
}

export function isLibassAvailable() {
  const { ffmpeg } = resolveFfmpegBins();
  const result = spawnSync(ffmpeg, ["-filters"], { encoding: "utf8" });
  return result.stdout?.includes(" ass ") || result.stdout?.includes("subtitles");
}

function loadRecipe(workDir) {
  const recipePath = path.join(workDir, ARTIFACTS.recipeFinal);
  if (!fs.existsSync(recipePath)) {
    throw new Error(`Brak ${ARTIFACTS.recipeFinal} w ${workDir}`);
  }
  return EditRecipeV2Schema.parse(readJson(recipePath));
}

function loadSpatialIndex(workDir) {
  const spatialPath = path.join(workDir, SPATIAL_INDEX_FILE);
  if (!fs.existsSync(spatialPath)) {
    return null;
  }
  return readJson(spatialPath);
}

function selectOutputs(recipe, { outputId, format } = {}) {
  let outputs = recipe.outputs ?? [];
  if (outputId) {
    outputs = outputs.filter((o) => o.outputId === outputId);
  }
  if (format) {
    outputs = outputs.filter((o) => o.format === format);
  }
  return outputs;
}

/**
 * Render one output from recipe to MP4.
 */
export async function renderOutput({
  workDir,
  recipe,
  context,
  output,
  options = {},
}) {
  const encodeProfile = resolveEncodeProfile(options.encodeProfile ?? "production");
  const dimensions = resolveOutputDimensions(output.format, recipe);
  const spatialIndex = context.spatialIndex ?? loadSpatialIndex(workDir);
  const edl = buildRenderEdl(output, recipe, context, { spatialIndex });
  const warnings = [];
  const segmentWarnings = [];
  const segmentErrors = [];
  const probeDurationFn = options.probeDuration ?? probeDuration;
  const renderSegment = options.renderSegmentToFile
    ?? ((segment, ctx, outPath, segOptions) => renderSegmentToFile(segment, ctx, outPath, {
      ...segOptions,
      runFfmpeg: segOptions.runFfmpeg ?? options.runFfmpeg,
    }));

  if (options.dryRun) {
    for (const segment of edl.segments) {
      const { warnings: segWarnings } = buildSegmentFfmpegArgs(
        segment,
        context,
        segmentTempPath(renderTmpDir(workDir, output.outputId), 0),
        {
          format: output.format,
          encodeProfile,
          dimensions,
          recipe,
          spatialIndex,
        },
      );
      segmentWarnings.push(...segWarnings);
    }
    warnings.push(...segmentWarnings);
    return {
      edl,
      outputPath: null,
      warnings,
      segmentWarnings,
      segmentErrors,
      durationSec: edl.durationSec,
    };
  }

  const tmpDir = renderTmpDir(workDir, output.outputId);
  fs.mkdirSync(tmpDir, { recursive: true });

  const fromPass = normalizeFromPass(options.fromPass);
  const resume = resolveResumeStart(tmpDir, fromPass, edl.segments.length);
  const keepTmp = options.keepTmp === true || fromPass !== "segments";

  const segmentPaths = [];
  try {
    if (resume.runSegments) {
      for (let i = 0; i < edl.segments.length; i += 1) {
        const segment = edl.segments[i];
        const segPath = segmentTempPath(tmpDir, i);
        try {
          const segResult = await renderSegment(segment, context, segPath, {
            format: output.format,
            encodeProfile,
            dimensions,
            recipe,
            spatialIndex,
          });
          const segWarns = segResult.warnings ?? [];
          segmentWarnings.push(...segWarns);
          warnings.push(...segWarns);
          segmentPaths.push(segPath);
        } catch (err) {
          segmentErrors.push({
            segmentId: segment.segmentId,
            message: err instanceof Error ? err.message : String(err),
          });
          break;
        }
      }
    } else {
      segmentPaths.push(...loadSegmentPaths(tmpDir, edl.segments.length));
    }

    if (segmentErrors.length > 0) {
      return {
        edl,
        outputPath: null,
        warnings,
        segmentWarnings,
        segmentErrors,
        durationSec: null,
        encodeProfile: options.encodeProfile ?? "production",
      };
    }

    const concatPath = path.join(tmpDir, PASS_FILES.concat);
    const outputMoments = edl.creativeMoments ?? (recipe.creativeMoments ?? []).filter(
      (m) => m.outputId === output.outputId,
    );

    let appliedCrossfade = false;
    let appliedBeatSnaps = [];
    let alreadyAlignedBeatSnaps = [];

    let currentPath = resume.currentPath;

    if (shouldRunPass(fromPass, "concat")) {
      ({
        appliedCrossfade,
        appliedBeatSnaps,
        alreadyAlignedBeatSnaps,
      } = await concatSegmentFiles(segmentPaths, concatPath, {
        encodeProfile,
        segments: edl.segments,
        creativeMoments: outputMoments,
        audioIndex: context.audioIndex,
        tmpDir,
        runFfmpegFn: options.runFfmpeg,
      }));

      if (appliedBeatSnaps.length > 0) {
        realignEdlAfterBeatSnaps(edl, appliedBeatSnaps);
      }

      currentPath = concatPath;
    } else if (!currentPath && fs.existsSync(concatPath)) {
      currentPath = concatPath;
    }

    const { moments, warnings: crossfadeWarnings } = resolvePostConcatCreativeMoments({
      creativeMoments: outputMoments,
      segments: edl.segments,
      segmentPaths,
      appliedCrossfade,
      appliedBeatSnaps,
      alreadyAlignedBeatSnaps,
    });
    warnings.push(...crossfadeWarnings);
    const passesSkipped = [];
    let appliedCreativeMomentIds = [];
    let appliedCreativeTechniqueIds = [];
    if (resume.resumedFromPass) {
      passesSkipped.push(`resume_from_${resume.resumedFromPass}`);
    }
    if (moments.length > 0 && shouldRunPass(fromPass, "creative")) {
      if (options.skipCreative) {
        passesSkipped.push("creative");
      } else {
        const creativePath = path.join(tmpDir, PASS_FILES.creative);
        const result = await applyCreativeMoments(currentPath, creativePath, {
          moments,
          encodeProfile,
          dimensions,
          spatialIndex,
          context,
          segments: edl.segments,
        });
        warnings.push(...(result.warnings ?? []));
        appliedCreativeMomentIds = result.appliedMomentIds ?? [];
        appliedCreativeTechniqueIds = result.appliedTechniqueIds ?? [];
        currentPath = creativePath;
      }
    } else if (moments.length > 0 && !shouldRunPass(fromPass, "creative")) {
      passesSkipped.push("creative");
    }

    const hasSubtitles = edl.segments.some(
      (seg) => seg.subtitles && seg.subtitles.policy !== "off",
    );
    if (hasSubtitles && shouldRunPass(fromPass, "subs")) {
      if (options.skipSubtitles) {
        passesSkipped.push("subtitles");
      } else if (!isLibassAvailable()) {
        throw new Error(
          "Libass niedostępny w FFmpeg — napisy ASS wymagają buildu z libass. "
          + "Zainstaluj ffmpeg z libass (np. brew install ffmpeg) lub ustaw FFMPEG_PATH.",
        );
      } else {
        const assPath = path.join(tmpDir, "subs.ass");
        const subsPath = path.join(tmpDir, PASS_FILES.subs);
        const stylePresets = resolveStylePresets(recipe);
        await burnAssSubtitles({
          inputPath: currentPath,
          outputPath: subsPath,
          assPath,
          edl,
          context,
          stylePresets,
          format: output.format,
          dimensions,
        });
        currentPath = subsPath;
      }
    }

    const overlays = edl.segments.flatMap((seg) => seg.textOverlays ?? []);
    if (overlays.length > 0 && shouldRunPass(fromPass, "overlays")) {
      if (options.skipOverlays) {
        passesSkipped.push("overlays");
      } else {
        const gfxPath = path.join(tmpDir, PASS_FILES.overlays);
        await applyTextOverlays(currentPath, gfxPath, {
          overlays,
          encodeProfile,
          dimensions,
          stylePresets: resolveStylePresets(recipe),
          format: output.format,
        });
        currentPath = gfxPath;
      }
    }

    let audioMixApplied = false;
    let sfxApplied = false;
    let audioTechniquesApplied = false;
    let mixResult = null;
    if ((recipe.audioMixPlan || recipe.sfxPlan?.length || outputHasAudioCensorship(output)
        || hasAudioMixMoments(outputMoments))
      && shouldRunPass(fromPass, "audio_mix")) {
      if (options.skipAudioMix) {
        passesSkipped.push("audio_mix");
      } else {
        const mixPath = path.join(tmpDir, PASS_FILES.audio_mix);
        mixResult = await applyAudioMix(currentPath, mixPath, {
          recipe,
          output,
          context,
          creativeMoments: outputMoments,
          encodeProfile,
          runFfmpegFn: options.runFfmpeg,
        });
        currentPath = mixResult.outputPath;
        audioMixApplied = mixResult.applied;
        sfxApplied = mixResult.sfxApplied ?? false;
        audioTechniquesApplied = mixResult.audioTechniquesApplied ?? false;
        warnings.push(...(mixResult.warnings ?? []));

        if (mixResult.appliedAudioTechniques?.length) {
          const applied = new Set(mixResult.appliedAudioTechniques);
          for (let i = warnings.length - 1; i >= 0; i -= 1) {
            const w = warnings[i];
            if (w.code === "TECHNIQUE_AUDIO_ONLY" && applied.has(w.techniqueId)) {
              warnings.splice(i, 1);
            }
          }
        }
      }
    }

    const colorGradeAllowed = shouldAllowColorGrade(recipe.batchContext, recipe.colorGrade);
    if (colorGradeAllowed && shouldApplyColorGrade(recipe.colorGrade) && shouldRunPass(fromPass, "color_grade")) {
      if (options.skipColorGrade) {
        passesSkipped.push("color_grade");
      } else {
        const gradedPath = path.join(tmpDir, PASS_FILES.color_grade);
        await applyColorGrade(currentPath, gradedPath, {
          colorGrade: recipe.colorGrade,
          encodeProfile,
          runFfmpegFn: options.runFfmpeg,
        });
        currentPath = gradedPath;
      }
    }

    const finalPath = renderOutputPath(workDir, output.outputId, output.format);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.copyFileSync(currentPath, finalPath);

    const durationSec = await probeDurationFn(finalPath);

    return {
      edl,
      outputPath: finalPath,
      warnings,
      segmentWarnings,
      segmentErrors,
      durationSec,
      audioMixApplied,
      sfxApplied,
      audioTechniquesApplied,
      appliedCreativeMomentIds,
      appliedCreativeTechniqueIds,
      mixResult,
      encodeProfile: options.encodeProfile ?? "production",
      passesSkipped,
    };
  } finally {
    if (!keepTmp) {
      cleanupTempDir(tmpDir);
    }
  }
}

/**
 * Render all (or selected) outputs for a batch.
 */
export async function executeRender(workDir, options = {}) {
  const recipe = options.recipe ?? loadRecipe(workDir);
  assertRenderFidelity(recipe, options);
  const context = options.context ?? resolveRenderContext(workDir, recipe);
  const outputs = selectOutputs(recipe, options);

  if (outputs.length === 0) {
    throw new Error("Brak outputów do renderu (sprawdź --output-id / --format)");
  }

  if (!options.dryRun && !options.skipFfmpegCheck && !isFfmpegAvailable()) {
    throw new Error("FFmpeg niedostępny — zainstaluj ffmpeg lub ustaw FFMPEG_PATH");
  }

  const results = [];
  const manifest = {
    version: "1.0",
    batchId: recipe.batchId,
    renderedAt: new Date().toISOString(),
    encodeProfile: options.encodeProfile ?? "production",
    outputs: [],
    warnings: [],
  };
  let fidelityArtifact = null;

  for (const output of outputs) {
    const outPath = renderOutputPath(workDir, output.outputId, output.format);
    if (fs.existsSync(outPath) && !options.force && !options.dryRun) {
      manifest.outputs.push({
        outputId: output.outputId,
        format: output.format,
        outputPath: outPath,
        skipped: true,
        reason: "already_exists",
        segmentWarnings: [],
        segmentErrors: [],
      });
      continue;
    }

    const result = await renderOutput({
      workDir,
      recipe,
      context,
      output,
      options,
    });

    manifest.outputs.push({
      outputId: output.outputId,
      format: output.format,
      outputKind: output.outputKind ?? "main",
      outputPath: result.outputPath,
      durationSec: result.durationSec,
      edl: options.dryRun ? result.edl : undefined,
      warnings: result.warnings,
      segmentWarnings: result.segmentWarnings ?? [],
      segmentErrors: result.segmentErrors ?? [],
      audioMixApplied: result.audioMixApplied ?? false,
      sfxApplied: result.sfxApplied ?? false,
      audioTechniquesApplied: result.audioTechniquesApplied ?? false,
      passesSkipped: result.passesSkipped ?? [],
      skipped: false,
    });
    manifest.warnings.push(...(result.warnings ?? []));
    results.push(result);

    if (!options.dryRun && result.outputPath && result.edl) {
      const recorded = recordOutputFidelity(workDir, {
        batchId: recipe.batchId,
        output,
        recipe,
        edl: result.edl,
        context,
        result,
        enhancementIndex: context.audioEnhancementIndex ?? null,
      });
      fidelityArtifact = recorded.artifact;
    }
  }

  if (!options.dryRun) {
    const manifestPath = path.join(workDir, ARTIFACTS.renderManifest);
    writeJson(manifestPath, manifest);
  }

  if (fidelityArtifact) {
    manifest.fidelityWarnings = collectFidelityCliWarnings(fidelityArtifact);
    manifest.fidelityPath = path.join(workDir, ARTIFACTS.montageFidelity);
  }

  return { results, manifest, fidelity: fidelityArtifact };
}
