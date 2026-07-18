import { EditRecipeSchema } from "../schemas/edit-recipe.js";

function getSegmentSceneIds(segment) {
  if (segment.videoRef) {
    const ids = [segment.videoRef.sceneId];
    if (segment.audioRef && segment.audioRef.sceneId !== segment.videoRef.sceneId) {
      ids.push(segment.audioRef.sceneId);
    }
    return ids;
  }
  if (segment.sourceRef) {
    return [segment.sourceRef.sceneId];
  }
  return [];
}

/**
 * SR1: Ten sam sceneId nie może wystąpić w dwóch różnych outputId tego samego formatu.
 */
export function validateSceneRegistryV2(recipe) {
  const issues = [];
  const byFormat = new Map();

  for (const output of recipe.outputs) {
    for (const segment of output.timeline) {
      for (const sceneId of getSegmentSceneIds(segment)) {
        const key = output.format;
        if (!byFormat.has(key)) {
          byFormat.set(key, new Map());
        }

        const usage = byFormat.get(key);
        if (usage.has(sceneId) && usage.get(sceneId) !== output.outputId) {
          issues.push({
            severity: "error",
            code: "SCENE_REUSE_SAME_FORMAT",
            message: `Scena ${sceneId} użyta w ${usage.get(sceneId)} i ${output.outputId} (format ${key})`,
            outputId: output.outputId,
            sceneId,
          });
        } else if (!usage.has(sceneId)) {
          usage.set(sceneId, output.outputId);
        }
      }
    }
  }

  // SR2: duplicate videoRef.sceneId in same output without allowBrollReuse
  for (const output of recipe.outputs) {
    const seen = new Map();
    const globalAllow = recipe.batchContext?.allowBrollReuse === true;

    for (const segment of output.timeline) {
      const sceneId = segment.videoRef?.sceneId ?? segment.sourceRef?.sceneId;
      if (!sceneId) continue;

      const allowReuse = globalAllow || segment.allowBrollReuse === true;
      const count = (seen.get(sceneId) ?? 0) + 1;
      seen.set(sceneId, count);

      if (count > 1 && !allowReuse) {
        issues.push({
          severity: "error",
          code: "SCENE_DUPLICATE_IN_OUTPUT",
          message: `Scena ${sceneId} powtórzona w ${output.outputId} bez allowBrollReuse`,
          outputId: output.outputId,
          sceneId,
        });
      }
    }
  }

  // SR5/SR6: excluded scenes
  const excludedByScene = new Map();
  for (const ex of recipe.excluded ?? []) {
    if (ex.exclusionType === "scene" && ex.sceneId) {
      excludedByScene.set(ex.sceneId, ex);
    }
    if (ex.exclusionType === "whole_clip" && ex.clipId && ex.usableAsBroll === false) {
      excludedByScene.set(`clip:${ex.clipId}`, ex);
    }
  }

  for (const output of recipe.outputs) {
    for (const segment of output.timeline) {
      for (const sceneId of getSegmentSceneIds(segment)) {
        const ex = excludedByScene.get(sceneId);
        if (ex && ex.usableAsBroll === false) {
          issues.push({
            severity: "error",
            code: "SCENE_EXCLUDED",
            message: `Scena ${sceneId} jest wykluczona (usableAsBroll: false)`,
            outputId: output.outputId,
            sceneId,
          });
        }
        if (ex && ex.usableAsBroll === true && segment.segmentRole !== "broll") {
          issues.push({
            severity: "error",
            code: "SCENE_AROLL_EXCLUDED",
            message: `Scena ${sceneId} wykluczona z A-roll — dozwolona tylko jako broll`,
            outputId: output.outputId,
            sceneId,
          });
        }
      }

      const clipEx = excludedByScene.get(`clip:${segment.videoRef?.clipId ?? segment.sourceRef?.clipId}`);
      if (clipEx && clipEx.usableAsBroll === false) {
        issues.push({
          severity: "error",
          code: "SCENE_EXCLUDED",
          message: `Klip ${clipEx.clipId} jest całkowicie wykluczony`,
          outputId: output.outputId,
        });
      }
    }
  }

  return issues;
}

/**
 * v1: Dla danego formatu ten sam sceneId nie może wystąpić w dwóch różnych outputId.
 */
export function validateSceneRegistry(recipe) {
  const issues = [];
  const byFormat = new Map();

  for (const output of recipe.outputs) {
    for (const segment of output.timeline) {
      const sceneId = segment.sourceRef?.sceneId ?? segment.videoRef?.sceneId;
      if (!sceneId) continue;
      const key = output.format;
      if (!byFormat.has(key)) {
        byFormat.set(key, new Map());
      }

      const usage = byFormat.get(key);
      if (usage.has(sceneId) && usage.get(sceneId) !== output.outputId) {
        issues.push({
          severity: "error",
          code: "SCENE_REUSE_WITHIN_FORMAT",
          message: `Scena ${sceneId} użyta w ${usage.get(sceneId)} i ${output.outputId} (format ${key})`,
          outputId: output.outputId,
          sceneId,
        });
      } else {
        usage.set(sceneId, output.outputId);
      }
    }
  }

  return issues;
}

export function validateMinOutputs(recipe, requiredFormats = ["16:9", "9:16"]) {
  const issues = [];
  const present = new Set(recipe.outputs.map((o) => o.format));

  for (const format of requiredFormats) {
    if (!present.has(format)) {
      issues.push({
        severity: "error",
        code: "MISSING_OUTPUT_FORMAT",
        message: `Brak outputu w formacie ${format}`,
      });
    }
  }

  return issues;
}

export function validateTimelineSegments(recipe) {
  const issues = [];

  for (const output of recipe.outputs) {
    for (const segment of output.timeline) {
      if (segment.videoOutSec <= segment.videoInSec) {
        issues.push({
          severity: "error",
          code: "INVALID_SEGMENT_RANGE",
          message: `Segment ${segment.segmentId}: videoOutSec <= videoInSec`,
          outputId: output.outputId,
          sceneId: segment.sourceRef?.sceneId ?? segment.videoRef?.sceneId,
        });
      }
    }
  }

  return issues;
}

export function validateEditRecipe(recipe, { requiredFormats = ["16:9", "9:16"] } = {}) {
  const parsed = EditRecipeSchema.parse(recipe);
  const issues = [
    ...validateMinOutputs(parsed, requiredFormats),
    ...validateSceneRegistry(parsed),
    ...validateTimelineSegments(parsed),
  ];

  return {
    valid: issues.filter((i) => i.severity === "error").length === 0,
    issues,
    recipe: parsed,
  };
}

export function buildSceneUsageRegistry(recipe) {
  const registry = [];

  for (const output of recipe.outputs) {
    const seen = new Set();
    for (const segment of output.timeline) {
      for (const sceneId of getSegmentSceneIds(segment)) {
        if (seen.has(sceneId)) {
          continue;
        }
        seen.add(sceneId);
        registry.push({
          sceneId,
          outputId: output.outputId,
          format: output.format === "9:16" ? "9:16" : "16:9",
        });
      }
    }
  }

  return registry;
}

export function buildSceneUsageRegistryV2(recipe) {
  return buildSceneUsageRegistry(recipe);
}
