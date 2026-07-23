import fs from "node:fs";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { censorWordForDisplay } from "../lib/profanity-censor.js";
import { isWhisperPromptEchoWord } from "../lib/whisper-prompt-echo.js";
import { findWordById } from "./audio-cuts.js";

export const MIN_CUE_SEC = 0.35;
const SAME_START_EPS = 0.02;

const BOILERPLATE_PATTERNS = [
  /amara\.org/i,
  /napisy stworzone przez/i,
  /społeczność amara/i,
  /zapisz każde słowo/i,
  /bez eufemizmów/i,
  /wulgaryzm/i,
];

function assColor(hex) {
  const h = hex.replace("#", "");
  if (h.length === 6) {
    const r = h.slice(0, 2);
    const g = h.slice(2, 4);
    const b = h.slice(4, 6);
    return `&H00${b}${g}${r}&`;
  }
  return "&H00FFFFFF&";
}

function formatAssTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function wordOutputTime(word, segment, segmentIndex, segments) {
  const sourceTime = word.start;
  let baseStart = segment.outputStartSec;

  if (segment.audioPolicy === "from_prev" && segmentIndex > 0) {
    baseStart = segments[segmentIndex - 1].outputStartSec;
  } else if (segment.audioPolicy === "from_next" && segmentIndex + 1 < segments.length) {
    baseStart = segments[segmentIndex + 1].outputStartSec;
  }

  return baseStart + (sourceTime - segment.audioInSec);
}

function subtitleClipRange(segment, segmentIndex, segments) {
  if (segment.audioPolicy === "from_prev" && segmentIndex > 0) {
    const prev = segments[segmentIndex - 1];
    return {
      start: segment.subtitles?.outputStartSec ?? prev.outputStartSec,
      end: segment.subtitles?.outputEndSec ?? prev.outputEndSec,
    };
  }

  if (segment.audioPolicy === "from_next" && segmentIndex + 1 < segments.length) {
    const next = segments[segmentIndex + 1];
    return {
      start: segment.subtitles?.outputStartSec ?? next.outputStartSec,
      end: segment.subtitles?.outputEndSec ?? next.outputEndSec,
    };
  }

  const start = segment.subtitles?.outputStartSec ?? segment.outputStartSec;
  const end = segment.subtitles?.outputEndSec ?? segment.outputEndSec;
  return { start, end };
}

function subtitleWordText(word) {
  if (word.displayWord) {
    return word.displayWord;
  }
  if (word.isProfanity || ["bleep", "mute", "cut", "mask"].includes(word.safetyAction)) {
    return word.displayWord ?? censorWordForDisplay(word.word, "partial");
  }
  return word.word;
}

function clampEventTime(time, clipStart, clipEnd) {
  return Math.max(clipStart, Math.min(time, clipEnd));
}

export function isBoilerplateSubtitleWord(word, { neighbors = null } = {}) {
  const text = String(word?.word ?? "").trim();
  if (!text) {
    return true;
  }
  if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  return isWhisperPromptEchoWord(word, { neighbors: neighbors ?? undefined });
}

export function filterSubtitleWords(words, audioInSec, audioOutSec) {
  return (words ?? []).filter(
    (word, index, list) =>
      !isBoilerplateSubtitleWord(word, {
        neighbors: [list[index - 1], list[index + 1]].filter(Boolean),
      })
      && word.end > audioInSec
      && word.start < audioOutSec,
  );
}

function mergeSameStartClusters(words) {
  if (words.length === 0) {
    return [];
  }

  const clusters = [];
  let current = [words[0]];

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (Math.abs(word.start - current[0].start) <= SAME_START_EPS) {
      current.push(word);
    } else {
      clusters.push(current);
      current = [word];
    }
  }
  clusters.push(current);
  return clusters;
}

function clusterOutputEnd(cluster, nextClusterStart, clipEnd) {
  const start = cluster[0].start;
  const naturalEnd = Math.max(...cluster.map((word) => word.end));
  const minEnd = start + MIN_CUE_SEC;
  const holdEnd = nextClusterStart != null
    ? Math.min(nextClusterStart, clipEnd)
    : clipEnd;
  return Math.min(clipEnd, Math.max(minEnd, naturalEnd, holdEnd > start ? holdEnd : minEnd));
}

/**
 * Build word-by-word (or merged-cluster) subtitle cues on the output timeline.
 */
export function buildWordSubtitleEvents(wordsInRange, {
  segment,
  segmentIndex,
  segments,
  clipStart,
  clipEnd,
}) {
  const events = [];
  const clusters = mergeSameStartClusters(wordsInRange);

  for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
    const cluster = clusters[clusterIndex];
    const nextCluster = clusters[clusterIndex + 1];
    const rawStart = wordOutputTime(cluster[0], segment, segmentIndex, segments);
    const nextRawStart = nextCluster
      ? wordOutputTime(nextCluster[0], segment, segmentIndex, segments)
      : null;
    const sourceEnd = clusterOutputEnd(
      cluster,
      nextRawStart,
      clipEnd,
    );
    const rawEnd = rawStart + Math.max(MIN_CUE_SEC, sourceEnd - cluster[0].start);
    const start = clampEventTime(rawStart, clipStart, clipEnd);
    const end = clampEventTime(
      nextRawStart != null ? Math.min(rawEnd, nextRawStart) : rawEnd,
      clipStart,
      clipEnd,
    );
    if (end <= start) {
      continue;
    }
    const text = cluster.map((word) => subtitleWordText(word)).join(" ");
    events.push({ start, end, text });
  }

  return events;
}

/**
 * Map subtitle placement / preset position to ASS Alignment (numpad).
 * bottom → 2, top → 8, center → 5
 */
export function resolveAssAlignment(placementOrPosition) {
  const value = String(placementOrPosition ?? "bottom").toLowerCase();
  if (value === "top" || value === "top_center") {
    return 8;
  }
  if (value === "center") {
    return 5;
  }
  return 2;
}

export function resolveSubtitlePlacement(segment, style) {
  return segment.subtitles?.placement
    ?? (style?.position === "top_center" ? "top"
      : style?.position === "center" ? "center"
        : "bottom");
}

function assStyleName(placement) {
  if (placement === "top") {
    return "Top";
  }
  if (placement === "center") {
    return "Center";
  }
  return "Bottom";
}

/**
 * Generate ASS file content for word-by-word subtitles on output timeline.
 */
export function generateAssSubtitles({ edl, context, stylePresets, format, dimensions }) {
  const styleKey = format === "9:16" ? "shorts" : "default";
  const style = stylePresets.subtitles[styleKey] ?? stylePresets.subtitles.default;
  const playResX = dimensions?.width ?? (format === "9:16" ? 1080 : 1920);
  const playResY = dimensions?.height ?? (format === "9:16" ? 1920 : 1080);
  const marginV = Math.round((style.safeMarginPct ?? 0.08) * playResY);
  const font = style.fontFamily;
  const size = style.fontSizePx;
  const primary = assColor(style.color);
  const outline = assColor(style.outlineColor ?? "#000000");
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Alignment, MarginV
Style: Default,${font},${size},${primary},${outline},-1,2,${marginV}
Style: Bottom,${font},${size},${primary},${outline},-1,2,${marginV}
Style: Top,${font},${size},${primary},${outline},-1,8,${marginV}
Style: Center,${font},${size},${primary},${outline},-1,5,${marginV}

[Events]
Format: Layer, Start, End, Style, Text
`;

  const events = [];
  const segments = edl.segments;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (!segment.subtitles || segment.subtitles.policy === "off") {
      continue;
    }

    const placement = resolveSubtitlePlacement(segment, style);
    const dialogueStyle = assStyleName(placement);

    const { start: clipStart, end: clipEnd } = subtitleClipRange(segment, segmentIndex, segments);

    const clipId = segment.subtitles.sourceClipId ?? segment.audioRef?.clipId;
    const wordIndex = context.wordIndexes[clipId];
    if (!wordIndex?.words?.length) {
      continue;
    }

    const wordsInRange = filterSubtitleWords(
      wordIndex.words,
      segment.audioInSec,
      segment.audioOutSec,
    );

    if (segment.subtitles.policy === "phrase") {
      if (wordsInRange.length === 0) {
        continue;
      }
      const start = clampEventTime(
        wordOutputTime(wordsInRange[0], segment, segmentIndex, segments),
        clipStart,
        clipEnd,
      );
      const lastWord = wordsInRange.at(-1);
      const phraseEndSource = lastWord.end > lastWord.start
        ? lastWord.end
        : lastWord.start + MIN_CUE_SEC;
      const end = clampEventTime(
        wordOutputTime({ ...lastWord, start: phraseEndSource }, segment, segmentIndex, segments),
        clipStart,
        clipEnd,
      );
      if (end <= start) {
        continue;
      }
      const text = wordsInRange.map((w) => subtitleWordText(w)).join(" ");
      events.push(`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},${dialogueStyle},${text}`);
      continue;
    }

    const wordEvents = buildWordSubtitleEvents(wordsInRange, {
      segment,
      segmentIndex,
      segments,
      clipStart,
      clipEnd,
    });
    for (const event of wordEvents) {
      events.push(
        `Dialogue: 0,${formatAssTime(event.start)},${formatAssTime(event.end)},${dialogueStyle},${event.text}`,
      );
    }
  }

  return `${header}${events.join("\n")}\n`;
}

export async function burnAssSubtitles({
  inputPath,
  outputPath,
  assPath,
  edl,
  context,
  stylePresets,
  format,
  dimensions,
}) {
  const assContent = generateAssSubtitles({ edl, context, stylePresets, format, dimensions });
  fs.writeFileSync(assPath, assContent, "utf8");

  const escapedAss = assPath.replace(/:/g, "\\:").replace(/'/g, "'\\''");

  await runFfmpeg(
    [
      "-y",
      "-i", inputPath,
      "-vf", `ass='${escapedAss}'`,
      "-c:a", "copy",
      outputPath,
    ],
    { label: "burn ASS subtitles" },
  );

  return outputPath;
}

export { findWordById };
