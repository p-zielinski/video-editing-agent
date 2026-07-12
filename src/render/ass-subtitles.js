import fs from "node:fs";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { censorWordForDisplay } from "../lib/profanity-censor.js";
import { findWordById } from "./audio-cuts.js";

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

/**
 * Generate ASS file content for word-by-word subtitles on output timeline.
 */
export function generateAssSubtitles({ edl, context, stylePresets, format, dimensions }) {
  const styleKey = format === "9:16" ? "shorts" : "default";
  const style = stylePresets.subtitles[styleKey] ?? stylePresets.subtitles.default;
  const playResX = dimensions?.width ?? (format === "9:16" ? 1080 : 1920);
  const playResY = dimensions?.height ?? (format === "9:16" ? 1920 : 1080);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Alignment, MarginV
Style: Default,${style.fontFamily},${style.fontSizePx},${assColor(style.color)},${assColor(style.outlineColor ?? "#000000")},-1,2,${Math.round((style.safeMarginPct ?? 0.08) * playResY)}

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

    const { start: clipStart, end: clipEnd } = subtitleClipRange(segment, segmentIndex, segments);

    const clipId = segment.subtitles.sourceClipId ?? segment.audioRef?.clipId;
    const wordIndex = context.wordIndexes[clipId];
    if (!wordIndex?.words?.length) {
      continue;
    }

    const wordsInRange = wordIndex.words.filter(
      (w) => w.start >= segment.audioInSec && w.end <= segment.audioOutSec,
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
      const end = clampEventTime(
        wordOutputTime(wordsInRange.at(-1), segment, segmentIndex, segments),
        clipStart,
        clipEnd,
      );
      if (end <= start) {
        continue;
      }
      const text = wordsInRange.map((w) => subtitleWordText(w)).join(" ");
      events.push(`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,${text}`);
      continue;
    }

    for (const word of wordsInRange) {
      const rawStart = wordOutputTime(word, segment, segmentIndex, segments);
      const rawEnd = rawStart + Math.max(0.08, word.end - word.start);
      const start = clampEventTime(rawStart, clipStart, clipEnd);
      const end = clampEventTime(rawEnd, clipStart, clipEnd);
      if (end <= start) {
        continue;
      }
      events.push(`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,${subtitleWordText(word)}`);
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
