import { resolveWordIndexForSegment } from "../lib/build-output-timeline.js";
import {
  findSubstantiveWordStartSec,
  isSetupNarrativeScene,
  resolveHookWordInpointSec,
  segmentOpensWithGreeting,
  shortSegmentStartsWithIntro,
} from "./shorts-greeting.js";
import {
  prependShortHookSegment,
  resolveBestHookScene,
  SHORT_HOOK_SEGMENT_ID,
} from "./shorts-retention.js";

function findShortOutput(recipe) {
  return recipe.outputs?.find((output) => output.outputKind === "short");
}

function roundSec(value) {
  return Math.round(value * 1000) / 1000;
}

function trimSegmentToInpoint(segment, inpointSec) {
  const currentIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const currentOut = segment.audioOutSec ?? segment.videoOutSec ?? currentIn;
  if (inpointSec <= currentIn + 0.05 || inpointSec >= currentOut - 0.5) {
    return false;
  }

  segment.videoInSec = roundSec(inpointSec);
  segment.audioInSec = roundSec(inpointSec);
  return true;
}

/**
 * Skip greeting/setup openings on short timelines — mid-sentence inpoint or hook prepend.
 * @param {object} recipe
 * @param {{ abstraction?: object, timelineIndex?: object, audioIndex?: object, wordIndexes?: object[] }} [options]
 */
export function enrichRecipeShortIntroSkip(recipe, {
  abstraction,
  timelineIndex,
  audioIndex,
  wordIndexes = null,
} = {}) {
  const shortOutput = findShortOutput(recipe);
  if (!shortOutput?.timeline?.length) {
    return recipe;
  }

  const first = shortOutput.timeline[0];
  if (first.segmentId === SHORT_HOOK_SEGMENT_ID) {
    return recipe;
  }

  const sceneId = first.videoRef?.sceneId ?? first.audioRef?.sceneId;
  const needsSkip = shortSegmentStartsWithIntro(first, wordIndexes ?? [], timelineIndex)
    || (sceneId && isSetupNarrativeScene(sceneId, abstraction));

  if (!needsSkip) {
    return recipe;
  }

  const wordIndex = resolveWordIndexForSegment(first, wordIndexes);
  const sourceIn = first.audioInSec ?? first.videoInSec ?? 0;
  const sourceOut = first.audioOutSec ?? first.videoOutSec ?? sourceIn;

  if (wordIndex) {
    const scene = (timelineIndex?.scenes ?? []).find((entry) => entry.sceneId === sceneId);
    const sceneStart = scene?.startSec ?? sourceIn;
    const sceneEnd = scene?.endSec ?? sourceOut;
    const inpoint = segmentOpensWithGreeting(wordIndex, sourceIn)
      ? findSubstantiveWordStartSec(wordIndex, sourceIn)
      : resolveHookWordInpointSec(wordIndex, Math.max(sceneStart, sourceIn), sceneEnd);

    if (inpoint != null && trimSegmentToInpoint(first, inpoint)) {
      recipe.shortsIntroSkipMeta = {
        applied: true,
        strategy: "mid_sentence_inpoint",
        inpointSec: inpoint,
      };
      return recipe;
    }
  }

  const { sceneId: hookSceneId } = resolveBestHookScene(
    abstraction ?? {},
    timelineIndex ?? {},
    audioIndex,
  );
  if (hookSceneId) {
    const prepended = prependShortHookSegment(
      shortOutput,
      hookSceneId,
      timelineIndex,
      {
        allowBrollReuse: recipe.batchContext?.allowBrollReuse ?? false,
        wordIndexes,
      },
    );
    if (prepended) {
      recipe.shortsIntroSkipMeta = {
        applied: true,
        strategy: "prepend_hook",
        hookSceneId,
      };
    }
  }

  return recipe;
}
