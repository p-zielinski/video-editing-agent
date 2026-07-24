import fs from "node:fs";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { resolveSegmentOutputDuration } from "../lib/build-output-timeline.js";
import { buildXfadeVideoFilter } from "./xfade-transitions.js";

/**
 * Overlap at boundary between segment i-1 and segment i.
 */
export function overlapAtBoundary(segments, index) {
  if (index <= 0 || index >= segments.length) {
    return 0;
  }
  const fromPrev = segments[index]?.audioPolicy === "from_prev"
    ? (segments[index].overlapSec ?? 0)
    : 0;
  const fromNext = segments[index - 1]?.audioPolicy === "from_next"
    ? (segments[index - 1].overlapSec ?? 0)
    : 0;
  return Math.max(fromPrev, fromNext);
}

/**
 * Segments with an audio stream in the segment MP4 (JL-cut compositor input).
 * from_next is video-only; from_prev embeds own audio for the non-overlap tail.
 */
export function segmentHasEmbeddedAudio(segment) {
  const policy = segment.audioPolicy ?? "from_video_ref";
  return policy !== "from_next" && policy !== "mute";
}

function segmentVideoDurationSec(segment) {
  if (segment.outputStartSec != null && segment.outputEndSec != null) {
    return Math.max(0.01, segment.outputEndSec - segment.outputStartSec);
  }
  return Math.max(0.01, segment.videoOutSec - segment.videoInSec);
}

/**
 * Effective video duration after J/L overlap trim/pad at concat.
 */
export function resolveJlVideoSegmentDuration(segIdx, segments) {
  let dur = segmentVideoDurationSec(segments[segIdx]);
  if (segIdx > 0 && segments[segIdx].audioPolicy === "from_prev") {
    dur -= overlapAtBoundary(segments, segIdx);
  }
  if (segments[segIdx].audioPolicy === "from_next") {
    dur += segments[segIdx].overlapSec ?? 0;
  }
  return Math.max(0.01, dur);
}

/**
 * Per-segment video filter: L-cut trims start; J-cut extends end with frozen last frame.
 */
export function buildJlVideoInputFilter(segIdx, segments) {
  const outLabel = `s${segIdx}v`;
  let chain = `[${segIdx}:v]setpts=PTS-STARTPTS`;

  if (segIdx > 0 && segments[segIdx].audioPolicy === "from_prev") {
    const trimStart = overlapAtBoundary(segments, segIdx);
    if (trimStart > 0) {
      chain += `,trim=start=${trimStart},setpts=PTS-STARTPTS`;
    }
  }

  if (segments[segIdx].audioPolicy === "from_next") {
    const padEnd = segments[segIdx].overlapSec ?? 0;
    if (padEnd > 0) {
      chain += `,tpad=stop_mode=clone:stop_duration=${padEnd}`;
    }
  }

  return `${chain}[${outLabel}]`;
}

function segmentRenderedTimelineSpanSec(segment) {
  if (segment.outputStartSec != null && segment.outputEndSec != null) {
    return Math.max(0.01, segment.outputEndSec - segment.outputStartSec);
  }
  return resolveSegmentOutputDuration(segment, { wordIndex: segment.wordIndex ?? null });
}

function totalOutputDurationSec(segments) {
  let total = 0;
  for (let i = 0; i < segments.length; i += 1) {
    total += segmentRenderedTimelineSpanSec(segments[i]);
    if (i > 0) {
      total -= overlapAtBoundary(segments, i);
    }
  }
  return Math.max(0.01, total);
}

function segmentRenderedAudioDur(segment) {
  if (!segmentHasEmbeddedAudio(segment)) {
    return 0;
  }
  return resolveSegmentOutputDuration(segment, { wordIndex: segment.wordIndex ?? null });
}

export function hasJlCutOverlap(segments) {
  if (!segments || segments.length < 2) {
    return false;
  }
  for (const seg of segments) {
    if (seg.audioPolicy === "from_prev" || seg.audioPolicy === "from_next") {
      return true;
    }
  }
  for (let i = 1; i < segments.length; i += 1) {
    if (overlapAtBoundary(segments, i) > 0) {
      return true;
    }
  }
  return false;
}

function mergeAudioStreams(parts, leftLabel, rightLabel, overlap, outLabel) {
  if (overlap > 0) {
    parts.push(
      `${leftLabel}${rightLabel}acrossfade=d=${overlap}:c1=tri:c2=tri${outLabel}`,
    );
    return;
  }
  parts.push(`${leftLabel}${rightLabel}concat=n=2:v=0:a=1${outLabel}`);
}

function appendJlCutVideoChain(parts, n, segments, crossfadeAtBoundaries) {
  const segmentDurations = segments.map((_, i) => resolveJlVideoSegmentDuration(i, segments));

  for (let i = 0; i < n; i += 1) {
    parts.push(buildJlVideoInputFilter(i, segments));
  }

  let curV = "s0v";
  let curDur = segmentDurations[0] ?? 0;
  let stepIdx = 0;

  for (let b = 0; b < n - 1; b += 1) {
    const nextIdx = b + 1;
    const cf = crossfadeAtBoundaries?.[b];
    const isLast = b === n - 2;
    const outV = isLast ? "outv" : `mv${stepIdx}`;

    if (cf) {
      const d = Math.max(0.05, cf.durationSec);
      const offset = Math.max(0, curDur - d);
      parts.push(buildXfadeVideoFilter(curV, `s${nextIdx}v`, outV, {
        durationSec: d,
        offsetSec: offset,
        transitionType: cf.transitionType ?? "fade",
      }));
      curDur += (segmentDurations[nextIdx] ?? 0) - d;
    } else {
      parts.push(`[${curV}][s${nextIdx}v]concat=n=2:v=1:a=0[${outV}]`);
      curDur += segmentDurations[nextIdx] ?? 0;
    }

    curV = outV;
    stepIdx += 1;
  }
}

/**
 * Build filter_complex for J/L-cut compositing.
 * Video concatenates all inputs (or xfade at eligible crossfade joins when crossfadeAtBoundaries
 * is set). Audio always follows J/L overlap rules — when both crossfade and J/L overlap exist at a
 * join, J/L audio wins (acrossfade on overlapSec) and only video may xfade.
 */
export function buildJlCutFilterComplex(segmentPaths, segments, crossfadeAtBoundaries = null) {
  const n = segmentPaths.length;
  if (n < 2) {
    return null;
  }

  const parts = [];
  const useVideoXfade = Boolean(crossfadeAtBoundaries?.some(Boolean));

  if (useVideoXfade) {
    appendJlCutVideoChain(parts, n, segments, crossfadeAtBoundaries);
  } else {
    const videoLabels = [];
    for (let i = 0; i < n; i += 1) {
      parts.push(buildJlVideoInputFilter(i, segments));
      videoLabels.push(`[s${i}v]`);
    }
    parts.push(`${videoLabels.join("")}concat=n=${n}:v=1:a=0[outv]`);
  }

  let audioChain = null;
  const consumedAudioStartSec = new Map();

  for (let i = 0; i < n; i += 1) {
    const policy = segments[i].audioPolicy ?? "from_video_ref";

    if (policy === "from_prev" && i > 0) {
      const videoDur = segmentVideoDurationSec(segments[i]);
      const overlap = overlapAtBoundary(segments, i);
      const carryDur = overlap;
      const remainderDur = Math.max(0, videoDur - overlap);
      const prevIdx = i - 1;
      const prevAudioDur = segmentRenderedAudioDur(segments[prevIdx]);
      const carryStart = Math.max(0, prevAudioDur - overlap);

      let segAudioLabel = null;

      if (carryDur > 0) {
        const carryLabel = `[carry${i}]`;
        parts.push(
          `[${prevIdx}:a]asetpts=PTS-STARTPTS[pa${prevIdx}];`
          + `[pa${prevIdx}]atrim=start=${carryStart}:duration=${carryDur},asetpts=PTS-STARTPTS${carryLabel}`,
        );
        segAudioLabel = carryLabel;
      }

      if (remainderDur > 0) {
        const ownLabel = `[own${i}]`;
        parts.push(
          `[${i}:a]asetpts=PTS-STARTPTS[raw${i}own];`
          + `[raw${i}own]atrim=start=${overlap}:duration=${remainderDur},asetpts=PTS-STARTPTS${ownLabel}`,
        );
        if (segAudioLabel) {
          const combinedLabel = `[seg${i}a]`;
          parts.push(`${segAudioLabel}${ownLabel}concat=n=2:v=0:a=1${combinedLabel}`);
          segAudioLabel = combinedLabel;
        } else {
          segAudioLabel = ownLabel;
        }
      }

      if (!segAudioLabel) {
        continue;
      }

      if (audioChain) {
        const outLabel = `[aout${i}]`;
        mergeAudioStreams(parts, audioChain, segAudioLabel, overlap, outLabel);
        audioChain = outLabel;
      } else {
        audioChain = segAudioLabel;
      }
      continue;
    }

    if (policy === "from_next" && i + 1 < n) {
      const pullDur = segmentVideoDurationSec(segments[i]);
      const overlap = segments[i].overlapSec ?? 0;
      const nextIdx = i + 1;
      const pullLabel = `[pull${i}]`;

      parts.push(
        `[${nextIdx}:a]asetpts=PTS-STARTPTS[raw${nextIdx}a];`
        + `[raw${nextIdx}a]atrim=0:${pullDur},asetpts=PTS-STARTPTS${pullLabel}`,
      );

      if (audioChain) {
        const outLabel = `[aout${i}]`;
        mergeAudioStreams(parts, audioChain, pullLabel, overlap, outLabel);
        audioChain = outLabel;
      } else {
        audioChain = pullLabel;
      }

      const already = consumedAudioStartSec.get(nextIdx) ?? 0;
      consumedAudioStartSec.set(nextIdx, already + Math.max(0, pullDur - overlap));
      continue;
    }

    if (!segmentHasEmbeddedAudio(segments[i])) {
      continue;
    }

    const overlap = overlapAtBoundary(segments, i);
    const consumed = consumedAudioStartSec.get(i) ?? 0;
    const audioLabel = `[a${i}]`;

    if (consumed > 0) {
      parts.push(
        `[${i}:a]asetpts=PTS-STARTPTS[raw${i}a];`
        + `[raw${i}a]atrim=start=${consumed},asetpts=PTS-STARTPTS${audioLabel}`,
      );
    } else {
      parts.push(`[${i}:a]asetpts=PTS-STARTPTS${audioLabel}`);
    }

    if (audioChain === null) {
      audioChain = audioLabel;
    } else {
      const outLabel = `[aout${i}]`;
      mergeAudioStreams(parts, audioChain, audioLabel, overlap, outLabel);
      audioChain = outLabel;
    }
  }

  if (!audioChain) {
    return null;
  }

  const totalVideoSec = totalOutputDurationSec(segments);
  parts.push(`${audioChain}apad=whole_dur=${totalVideoSec},asetpts=PTS-STARTPTS[outa]`);

  return {
    filterComplex: parts.join(";"),
    videoMap: "[outv]",
    audioMap: "[outa]",
  };
}

/**
 * J/L-cut compositing: when segments use from_prev/from_next, re-encode with audio overlap.
 */
export async function applyJlCutAudio(segmentPaths, segments, outputPath, {
  encodeProfile,
  crossfadeAtBoundaries = null,
  runFfmpegFn = runFfmpeg,
} = {}) {
  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], outputPath);
    return;
  }

  if (hasJlCutOverlap(segments)) {
    const built = buildJlCutFilterComplex(segmentPaths, segments, crossfadeAtBoundaries);
    if (!built) {
      throw new Error("applyJlCutAudio: nie udało się zbudować filter_complex dla J/L-cut");
    }
    const inputArgs = segmentPaths.flatMap((p) => ["-i", p]);

    await runFfmpegFn(
      [
        "-y",
        ...inputArgs,
        "-filter_complex", built.filterComplex,
        "-map", built.videoMap,
        "-map", built.audioMap,
        "-c:v", encodeProfile.videoCodec,
        "-preset", encodeProfile.preset,
        "-crf", String(encodeProfile.crf),
        "-c:a", encodeProfile.audioCodec,
        "-b:a", encodeProfile.audioBitrate,
        "-movflags", "+faststart",
        outputPath,
      ],
      { label: "J/L-cut overlap mix" },
    );
    return;
  }

  const listPath = `${outputPath}.jl.txt`;
  const listContent = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(listPath, listContent);

  try {
    await runFfmpegFn(
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c:v", encodeProfile.videoCodec,
        "-preset", encodeProfile.preset,
        "-crf", String(encodeProfile.crf),
        "-c:a", encodeProfile.audioCodec,
        "-b:a", encodeProfile.audioBitrate,
        "-movflags", "+faststart",
        outputPath,
      ],
      { label: "concat J/L-cut fallback" },
    );
  } finally {
    if (fs.existsSync(listPath)) {
      fs.unlinkSync(listPath);
    }
  }
}
