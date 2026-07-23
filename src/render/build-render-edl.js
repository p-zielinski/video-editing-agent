import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import { enrichRenderEdl } from "./enrich-render-edl.js";
import { resolveWordIndexForSegment } from "./ffmpeg-segment.js";

function mapSegmentToEdl(segment, context) {
  return {
    segmentId: segment.segmentId,
    segmentRole: segment.segmentRole,
    videoRef: segment.videoRef,
    audioRef: segment.audioRef,
    videoInSec: segment.videoInSec,
    videoOutSec: segment.videoOutSec,
    audioInSec: segment.audioInSec ?? segment.videoInSec,
    audioOutSec: segment.audioOutSec ?? segment.videoOutSec,
    audioPolicy: segment.audioPolicy,
    syncMode: segment.syncMode ?? "align_start",
    overlapSec: segment.overlapSec ?? 0,
    outputStartSec: segment.outputStartSec,
    outputEndSec: segment.outputEndSec,
    cuts: segment.cuts ?? [],
    wordIndex: resolveWordIndexForSegment(segment, context),
    subtitles: segment.subtitles,
    textOverlays: segment.textOverlays ?? [],
    videoTransform: segment.videoTransform,
    sourceVolumeDb: segment.sourceVolumeDb,
    intent: segment.intent,
    ...(segment.preserveAmbientAudio === true ? { preserveAmbientAudio: true } : {}),
  };
}

/**
 * Build a render EDL for one output from recipe timeline + resolved batch context.
 */
export function buildRenderEdl(output, recipe, context, enrichOptions = {}) {
  const timeline = buildOutputTimeline(output, { wordIndexes: context.wordIndexes });
  const segments = timeline.map((segment) => mapSegmentToEdl(segment, context));
  const durationSec = segments.length > 0
    ? Math.max(...segments.map((seg) => seg.outputEndSec ?? 0))
    : 0;

  const edl = {
    outputId: output.outputId,
    format: output.format,
    outputKind: output.outputKind ?? "main",
    durationSec,
    segments,
  };

  return enrichRenderEdl(edl, {
    recipe,
    context,
    output,
    spatialIndex: enrichOptions.spatialIndex ?? null,
  });
}
