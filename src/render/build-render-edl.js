import { buildOutputTimeline } from "../lib/build-output-timeline.js";

function resolveVideoSourcePath(segment, context) {
  const clipId = segment.videoRef?.clipId;
  return clipId ? context.clips[clipId]?.sourcePath ?? null : null;
}

function resolveAudioSourcePath(segment, context) {
  switch (segment.audioPolicy) {
    case "external":
      return context.musicBed?.trackFilePath ?? null;
    case "from_audio_ref": {
      const clipId = segment.audioRef?.clipId;
      return clipId ? context.clips[clipId]?.sourcePath ?? null : null;
    }
    case "from_prev":
    case "from_next":
    case "from_video_ref":
    default: {
      const clipId = segment.videoRef?.clipId ?? segment.audioRef?.clipId;
      return clipId ? context.clips[clipId]?.sourcePath ?? null : null;
    }
  }
}

function mapSegmentToEdl(segment, context) {
  return {
    segmentId: segment.segmentId,
    videoSourcePath: resolveVideoSourcePath(segment, context),
    audioSourcePath: resolveAudioSourcePath(segment, context),
    videoInSec: segment.videoInSec,
    videoOutSec: segment.videoOutSec,
    audioInSec: segment.audioInSec ?? segment.videoInSec,
    audioOutSec: segment.audioOutSec ?? segment.videoOutSec,
    audioPolicy: segment.audioPolicy,
    outputStartSec: segment.outputStartSec,
    outputEndSec: segment.outputEndSec,
    cuts: segment.cuts ?? [],
  };
}

/**
 * Build a render EDL for one output from recipe timeline + resolved batch context.
 *
 * @param {object} output - recipe.outputs[] entry
 * @param {object} recipe - full EditRecipe (reserved for future cross-output refs)
 * @param {object} context - result of resolveRenderContext()
 * @returns {{
 *   outputId: string,
 *   format: string,
 *   durationSec: number,
 *   segments: Array<object>,
 * }}
 */
export function buildRenderEdl(output, recipe, context) {
  void recipe;

  const timeline = buildOutputTimeline(output);
  const segments = timeline.map((segment) => mapSegmentToEdl(segment, context));
  const durationSec = segments.length > 0
    ? Math.max(...segments.map((seg) => seg.outputEndSec ?? 0))
    : 0;

  return {
    outputId: output.outputId,
    format: output.format,
    durationSec,
    segments,
  };
}
