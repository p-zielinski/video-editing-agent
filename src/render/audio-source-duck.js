import { mergeIntervals, SPEECH_MERGE_GAP_SEC } from "../editorial/speech-ducking.js";

/** Crossfade between enhanced speech and original ambient (50–80 ms). */
export const SOURCE_DUCK_CROSSFADE_SEC = 0.06;

function roundSec(value) {
  return Math.round(value * 1000) / 1000;
}

function resolveSegmentAudioRange(segment) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const audioOut = segment.audioOutSec ?? segment.videoOutSec ?? audioIn;
  return { audioIn, audioOut, durationSec: Math.max(0, audioOut - audioIn) };
}

/**
 * Map source-timeline words into segment-relative [0, duration] speech intervals.
 * Near-adjacent words are merged via speech-ducking mergeIntervals.
 *
 * @param {{ start: number, end: number }[]|null|undefined} words
 * @param {number} audioIn
 * @param {number} audioOut
 * @param {number} [mergeGapSec]
 * @returns {{ start: number, end: number }[]}
 */
export function collectSegmentRelativeSpeechIntervals(
  words,
  audioIn,
  audioOut,
  mergeGapSec = SPEECH_MERGE_GAP_SEC,
) {
  if (!words?.length || !(audioOut > audioIn)) {
    return [];
  }

  const intervals = [];
  for (const word of words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) {
      continue;
    }
    if (word.end <= audioIn || word.start >= audioOut) {
      continue;
    }
    const start = roundSec(Math.max(0, Math.max(word.start, audioIn) - audioIn));
    const end = roundSec(Math.min(audioOut, word.end) - audioIn);
    if (end > start + 0.02) {
      intervals.push({ start, end });
    }
  }

  return mergeIntervals(intervals, mergeGapSec).map((iv) => ({
    start: roundSec(iv.start),
    end: roundSec(iv.end),
  }));
}

/**
 * Full-coverage source windows: speech → enhanced, gaps → original.
 *
 * @param {{ start: number, end: number }[]} speechIntervals
 * @param {number} durationSec
 * @returns {{ startSec: number, endSec: number, source: "enhanced"|"original" }[]}
 */
export function fillSpeechAmbientWindows(speechIntervals, durationSec) {
  if (!(durationSec > 0)) {
    return [];
  }

  if (!speechIntervals?.length) {
    return [{ startSec: 0, endSec: roundSec(durationSec), source: "enhanced" }];
  }

  const windows = [];
  let cursor = 0;

  for (const region of speechIntervals) {
    const start = roundSec(Math.max(0, region.start));
    const end = roundSec(Math.min(durationSec, region.end));
    if (end <= start + 0.02) {
      continue;
    }
    if (start > cursor + 0.02) {
      windows.push({ startSec: roundSec(cursor), endSec: start, source: "original" });
    }
    windows.push({ startSec: start, endSec: end, source: "enhanced" });
    cursor = end;
  }

  if (cursor < durationSec - 0.02) {
    windows.push({
      startSec: roundSec(cursor),
      endSec: roundSec(durationSec),
      source: "original",
    });
  }

  return windows;
}

/**
 * Plan per-segment audio source switching: cleaned speech vs original ambient.
 *
 * @param {object} segment
 * @param {{ start: number, end: number }[]|null|undefined} words
 * @param {string|null|undefined} enhancedPath
 * @param {string|null|undefined} originalPath
 * @param {{ crossfadeSec?: number, mergeGapSec?: number }} [options]
 */
export function buildSpeechAmbientSourcePlan(
  segment,
  words,
  enhancedPath,
  originalPath,
  options = {},
) {
  const crossfadeSec = options.crossfadeSec ?? SOURCE_DUCK_CROSSFADE_SEC;
  const { audioIn, audioOut, durationSec } = resolveSegmentAudioRange(segment);
  const durationRounded = roundSec(durationSec);

  if (!originalPath) {
    return {
      mode: "none",
      windows: [],
      durationSec: durationRounded,
      crossfadeSec,
      originalPath: null,
      enhancedPath: enhancedPath ?? null,
    };
  }

  if (segment.preserveAmbientAudio === true || !enhancedPath) {
    return {
      mode: "original_only",
      windows: durationRounded > 0
        ? [{ startSec: 0, endSec: durationRounded, source: "original" }]
        : [],
      durationSec: durationRounded,
      crossfadeSec,
      originalPath,
      enhancedPath: null,
    };
  }

  const speech = collectSegmentRelativeSpeechIntervals(
    words,
    audioIn,
    audioOut,
    options.mergeGapSec ?? SPEECH_MERGE_GAP_SEC,
  );

  if (!speech.length) {
    return {
      mode: "enhanced_only",
      windows: durationRounded > 0
        ? [{ startSec: 0, endSec: durationRounded, source: "enhanced" }]
        : [],
      durationSec: durationRounded,
      crossfadeSec,
      originalPath,
      enhancedPath,
    };
  }

  return {
    mode: "speech_ambient_duck",
    windows: fillSpeechAmbientWindows(speech, durationRounded),
    durationSec: durationRounded,
    crossfadeSec,
    originalPath,
    enhancedPath,
  };
}

/**
 * Escape commas for FFmpeg filtergraph expression embedding.
 * @param {string} expr
 */
function escapeFilterExpr(expr) {
  return expr.replace(/,/g, "\\,");
}

/**
 * Piecewise linear gain 0..1 for one source across abutting windows.
 * Crossfade ramps live on [boundary, boundary+cf] so both sources overlap.
 *
 * @param {{ startSec: number, endSec: number, source: string }[]} windows
 * @param {"enhanced"|"original"} source
 * @param {number} crossfadeSec
 * @param {number} durationSec
 */
export function buildSourceVolumeExpr(windows, source, crossfadeSec, durationSec) {
  const cf = Math.max(0.001, crossfadeSec);
  const active = (windows ?? []).filter((w) => w.source === source);
  if (!active.length) {
    return "0";
  }

  // Nested ifs from last window backward; max-style compose via gt() for overlaps.
  let expr = "0";
  for (let i = active.length - 1; i >= 0; i -= 1) {
    const { startSec, endSec } = active[i];
    const isFirst = startSec <= 0.001;
    const isLast = endSec >= durationSec - 0.001;
    const s = roundSec(startSec);
    const e = roundSec(endSec);
    const fadeInEnd = roundSec(isFirst ? startSec : startSec + cf);
    const fadeOutEnd = roundSec(isLast ? endSec : Math.min(durationSec, endSec + cf));

    let piece;
    if (isFirst && isLast) {
      piece = "1";
    } else if (isFirst) {
      piece = `if(lt(t,${e}),1,if(lt(t,${fadeOutEnd}),1-(t-${e})/${cf},0))`;
    } else if (isLast) {
      piece = `if(lt(t,${s}),0,if(lt(t,${fadeInEnd}),(t-${s})/${cf},1))`;
    } else {
      piece = `if(lt(t,${s}),0,if(lt(t,${fadeInEnd}),(t-${s})/${cf},if(lt(t,${e}),1,if(lt(t,${fadeOutEnd}),1-(t-${e})/${cf},0))))`;
    }

    expr = `if(gt(${piece},0),${piece},${expr})`;
  }

  return escapeFilterExpr(expr);
}

/**
 * Build FFmpeg filter_complex fragments for speech/ambient source ducking.
 *
 * @param {ReturnType<typeof buildSpeechAmbientSourcePlan>} plan
 * @param {{ enhancedLabel?: string, originalLabel?: string, outputLabel?: string }} [options]
 * @returns {{ filters: string[], outputLabel: string }}
 */
export function buildSourceDuckFilterGraph(plan, {
  enhancedLabel = "[enh]",
  originalLabel = "[orig]",
  outputLabel = "[aout]",
} = {}) {
  if (!plan || plan.mode === "none") {
    return { filters: [], outputLabel };
  }

  if (plan.mode === "original_only") {
    return {
      filters: [`${originalLabel}anull${outputLabel}`],
      outputLabel,
    };
  }

  if (plan.mode === "enhanced_only") {
    return {
      filters: [`${enhancedLabel}anull${outputLabel}`],
      outputLabel,
    };
  }

  const enhExpr = buildSourceVolumeExpr(
    plan.windows,
    "enhanced",
    plan.crossfadeSec,
    plan.durationSec,
  );
  const origExpr = buildSourceVolumeExpr(
    plan.windows,
    "original",
    plan.crossfadeSec,
    plan.durationSec,
  );

  return {
    filters: [
      `${enhancedLabel}volume='${enhExpr}':eval=frame[enhg]`,
      `${originalLabel}volume='${origExpr}':eval=frame[origg]`,
      `[enhg][origg]amix=inputs=2:duration=first:normalize=0:dropout_transition=${plan.crossfadeSec}${outputLabel}`,
    ],
    outputLabel,
  };
}
