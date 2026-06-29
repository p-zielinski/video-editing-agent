import fs from "node:fs";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { resolveSegmentOutputDuration } from "../lib/build-output-timeline.js";

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
 * Segments that borrow neighbor audio render video-only at segment pass.
 */
export function segmentHasEmbeddedAudio(segment) {
  const policy = segment.audioPolicy ?? "from_video_ref";
  return policy !== "from_prev"
    && policy !== "from_next"
    && policy !== "mute";
}

function segmentVideoDurationSec(segment) {
  if (segment.outputStartSec != null && segment.outputEndSec != null) {
    return Math.max(0.01, segment.outputEndSec - segment.outputStartSec);
  }
  return Math.max(0.01, segment.videoOutSec - segment.videoInSec);
}

function totalOutputDurationSec(segments) {
  let total = 0;
  for (let i = 0; i < segments.length; i += 1) {
    total += segmentVideoDurationSec(segments[i]);
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

/**
 * Build filter_complex for J/L-cut compositing.
 * Video concatenates all inputs; audio carries neighbor streams for from_prev/from_next.
 */
export function buildJlCutFilterComplex(segmentPaths, segments) {
  const n = segmentPaths.length;
  if (n < 2) {
    return null;
  }

  const parts = [];
  const videoLabels = [];

  for (let i = 0; i < n; i += 1) {
    parts.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`);
    videoLabels.push(`[v${i}]`);
  }

  parts.push(`${videoLabels.join("")}concat=n=${n}:v=1:a=0[outv]`);

  let audioChain = null;
  const consumedAudioStartSec = new Map();

  for (let i = 0; i < n; i += 1) {
    const policy = segments[i].audioPolicy ?? "from_video_ref";

    if (policy === "from_prev" && i > 0) {
      const carryDur = segmentVideoDurationSec(segments[i]);
      const overlap = overlapAtBoundary(segments, i);
      const prevIdx = i - 1;
      const prevAudioDur = segmentRenderedAudioDur(segments[prevIdx]);
      const carryStart = Math.max(0, prevAudioDur - overlap);
      const carryLabel = `[carry${i}]`;

      parts.push(
        `[${prevIdx}:a]asetpts=PTS-STARTPTS[pa${prevIdx}];`
        + `[pa${prevIdx}]atrim=start=${carryStart}:duration=${carryDur},asetpts=PTS-STARTPTS${carryLabel}`,
      );

      if (audioChain) {
        const outLabel = `[aout${i}]`;
        mergeAudioStreams(parts, audioChain, carryLabel, overlap, outLabel);
        audioChain = outLabel;
      } else {
        audioChain = carryLabel;
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
  runFfmpegFn = runFfmpeg,
}) {
  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], outputPath);
    return;
  }

  if (hasJlCutOverlap(segments)) {
    const built = buildJlCutFilterComplex(segmentPaths, segments);
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
