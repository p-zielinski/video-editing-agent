const REFRAME_MODES = new Set(["face", "subject"]);

function buildSceneAspectMap(scenes = []) {
  return new Map(scenes.map((scene) => [scene.sceneId, scene.aspectRatio]));
}

function aspectsMismatch(sourceAspect, outputFormat) {
  if (!sourceAspect || sourceAspect === "other") {
    return false;
  }
  return sourceAspect !== outputFormat;
}

function hasIntentionalReframe(segment) {
  const fitMode = segment.videoTransform?.fitMode;
  if (fitMode === "pillarbox" || fitMode === "pillarbox_blur" || fitMode === "fill") {
    return true;
  }
  const reframe = segment.videoTransform?.reframe;
  if (reframe && (reframe === "center" || REFRAME_MODES.has(reframe))) {
    return true;
  }
  return segment.videoTransform?.crop != null;
}

/**
 * Warn when source scene aspect does not match output format without reframe metadata.
 *
 * @param {object} recipe
 * @param {{ sceneAspectById?: Map<string, string> }} [options]
 */
export function validateAspectRatio(recipe, { sceneAspectById } = {}) {
  const issues = [];
  if (!sceneAspectById?.size) {
    return issues;
  }

  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      const sceneId = segment.videoRef?.sceneId;
      if (!sceneId) {
        continue;
      }

      const sourceAspect = sceneAspectById.get(sceneId);
      if (!aspectsMismatch(sourceAspect, output.format)) {
        continue;
      }

      if (hasIntentionalReframe(segment)) {
        continue;
      }

      const isVerticalBrollInLandscapeMain = sourceAspect === "9:16"
        && output.format === "16:9"
        && output.outputKind === "main"
        && segment.segmentRole === "broll";

      if (isVerticalBrollInLandscapeMain) {
        continue;
      }

      const isVerticalInLandscapeMain = sourceAspect === "9:16"
        && output.format === "16:9"
        && output.outputKind === "main"
        && segment.segmentRole === "aroll";

      issues.push({
        severity: "warning",
        code: isVerticalInLandscapeMain ? "V25-AR-02" : "V25-AR-01",
        message: isVerticalInLandscapeMain
          ? `Segment ${segment.segmentId}: pionowe A-roll (${sceneId}) w main 16:9 bez videoTransform — renderer doda pasy boczne`
          : `Segment ${segment.segmentId}: aspect ${sourceAspect} w output ${output.format} bez videoTransform.reframe/crop`,
        outputId: output.outputId,
        sceneId,
      });
    }
  }

  return issues;
}

export { buildSceneAspectMap };
