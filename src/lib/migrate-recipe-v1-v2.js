import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";

export function migrateSegmentV1ToV2(seg) {
  const ref = { clipId: seg.sourceRef.clipId, sceneId: seg.sourceRef.sceneId };
  const audioIn = seg.videoInSec + (seg.audioOffsetSec ?? 0);
  const audioOut = seg.videoOutSec + (seg.audioOffsetSec ?? 0);
  const { sourceRef, audioOffsetSec, ...rest } = seg;

  const textOverlays = (seg.textOverlays ?? []).map((o) => ({
    text: o.text,
    outputStartSec: o.outputStartSec ?? o.startSec,
    outputEndSec: o.outputEndSec ?? o.endSec,
    position: o.position,
  }));

  let audioPolicy = seg.audioPolicy;
  if (audioPolicy === "source") {
    audioPolicy = "from_video_ref";
  }

  return {
    ...rest,
    segmentRole: "aroll",
    videoRef: ref,
    audioRef: ref,
    videoInSec: seg.videoInSec,
    videoOutSec: seg.videoOutSec,
    audioInSec: audioIn,
    audioOutSec: audioOut,
    audioPolicy,
    overlapSec: 0,
    textOverlays,
  };
}

export function migrateExcludedV1ToV2(excluded) {
  return (excluded ?? []).map((item) => {
    if (item.exclusionType) {
      return item;
    }
    if (item.clipId && !item.sceneId) {
      return {
        clipId: item.clipId,
        exclusionType: "whole_clip",
        usableAsBroll: false,
        reason: item.reason,
        confidence: item.confidence,
      };
    }
    if (item.sceneId && item.startSec != null) {
      return {
        clipId: item.clipId,
        sceneId: item.sceneId,
        exclusionType: "time_range",
        timeRange: { startSec: item.startSec, endSec: item.endSec },
        usableAsBroll: false,
        reason: item.reason,
        confidence: item.confidence,
      };
    }
    if (item.sceneId) {
      return {
        clipId: item.clipId,
        sceneId: item.sceneId,
        exclusionType: "scene",
        usableAsBroll: false,
        reason: item.reason,
        confidence: item.confidence,
      };
    }
    return {
      exclusionType: "scene",
      sceneId: item.sceneId ?? "unknown",
      usableAsBroll: false,
      reason: item.reason,
      confidence: item.confidence,
    };
  });
}

export function migrateRecipeV1ToV2(recipe, {
  clipRegistry = [],
  requiredFormats = ["16:9", "9:16"],
  inputMode,
} = {}) {
  const minOutputs = recipe.batchContext?.minOutputs;
  const required = recipe.batchContext?.requiredFormats
    ?? minOutputs
    ?? requiredFormats;

  const batchContext = {
    theme: recipe.batchContext?.theme,
    dayLabel: recipe.batchContext?.dayLabel,
    challengeDay: recipe.batchContext?.challengeDay,
    targetPlatforms: recipe.batchContext?.targetPlatforms ?? [],
    notes: recipe.batchContext?.notes,
    qualityOverQuantity: recipe.batchContext?.qualityOverQuantity ?? true,
    requiredFormats: required,
    inputMode: inputMode ?? (clipRegistry.length <= 1 ? "single_clip" : "multi_clip_day"),
    allowWholeClipExclusion: true,
    brollStrategy: "match_speech_topics",
    brollMatchThreshold: 0.55,
    allowBrollReuse: false,
    maxBrollSegmentsPerOutput: 30,
    shortsStrategy: "standalone_highlights",
    shortsMaxDurationSec: 60,
  };

  if (minOutputs && !recipe.batchContext?.requiredFormats) {
    batchContext.minOutputs = minOutputs;
  }

  const outputs = recipe.outputs.map((output) => ({
    ...output,
    outputKind: output.outputKind ?? "main",
    timeline: output.timeline.map(migrateSegmentV1ToV2),
  }));

  const migrated = {
    version: "2.0",
    batchId: recipe.batchId,
    batchContext,
    clipRegistry,
    outputs,
    excluded: migrateExcludedV1ToV2(recipe.excluded),
    sceneUsageRegistry: recipe.sceneUsageRegistry ?? [],
    needsHumanReview: recipe.needsHumanReview ?? false,
    reviewNotes: recipe.reviewNotes,
  };

  return EditRecipeV2Schema.parse(migrated);
}
