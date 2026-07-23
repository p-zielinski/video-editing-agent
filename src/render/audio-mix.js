import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { measureLoudness } from "../lib/measure-loudness.js";
import { resolveTrackFilePath, resolveTrackById } from "../editorial/music-library.js";
import {
  resolveProfanityBleepSfx,
  resolveSfxById,
  resolveSfxByTag,
  resolveSfxFilePath,
} from "../editorial/sfx-library.js";
import { suggestSfxVolumeDb, PROFANITY_BLEEP_SFX_ID } from "../editorial/sfx-catalog-summary.js";
import { deriveSpeechDuckingWindows } from "../editorial/speech-ducking.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SFX_DIR = path.join(ROOT, "assets", "sfx");
const DEFAULT_VOICE_TARGET_LUFS = -16;
export const DEFAULT_DUCKING_DB = -12;
export const MUSIC_BED_AUDIO_TECHNIQUES = new Set(["music_swell", "music_drop"]);
export const VOICE_AUDIO_TECHNIQUES = new Set(["silence_beat", "voice_pitch_shift", "voice_emphasis_boost"]);
const DEFAULT_VOICE_SAMPLE_RATE = 44100;
const DEFAULT_SWELL_GAIN_DB = 3;
const DEFAULT_DROP_GAIN_DB = -6;
const DEFAULT_SILENCE_BEAT_VOLUME = 0.3;
export { PROFANITY_BLEEP_SFX_ID };
const DEFAULT_BLEEP_VOLUME_DB = -3;

/**
 * creativeMoments handled in the music-bed mix pass (not video creative).
 */
export function resolveMusicBedMoments(creativeMoments = []) {
  return creativeMoments.filter(
    (m) => !m.disabled && MUSIC_BED_AUDIO_TECHNIQUES.has(m.techniqueId),
  );
}

/**
 * creativeMoments that duck/gate the voice stream in the audio mix pass.
 */
export function resolveVoiceAudioMoments(creativeMoments = []) {
  return creativeMoments.filter(
    (m) => !m.disabled && VOICE_AUDIO_TECHNIQUES.has(m.techniqueId),
  );
}

/**
 * Whether creativeMoments require the audio mix pass (voice dips/mutes, bed automation).
 */
export function hasAudioMixMoments(creativeMoments = []) {
  return resolveMusicBedMoments(creativeMoments).length > 0
    || resolveVoiceAudioMoments(creativeMoments).length > 0;
}

/**
 * Collect profanity censorship windows from an output timeline (output seconds).
 */
export function resolveAudioCensorshipWindows(output) {
  const windows = [];
  for (const segment of output?.timeline ?? []) {
    for (const window of segment.audioCensorship ?? []) {
      windows.push(window);
    }
  }
  return windows.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Mute voice during censorship windows (bleep + mute modes).
 */
export function buildVoiceCensorshipMuteFilter(inputLabel, outputLabel, windows) {
  if (!windows.length) {
    return null;
  }

  const muteExpr = windows
    .map(({ startSec, endSec }) => `between(t\\,${startSec}\\,${endSec})`)
    .join("+");
  return `${inputLabel}volume='if(${muteExpr}\\,0\\,1)':eval=frame${outputLabel}`;
}

/**
 * Resolve bleep SFX overlays for censorship windows in bleep mode.
 */
export function resolveBleepSfxEntries(censorshipWindows = []) {
  const { sound: bleepSound } = resolveProfanityBleepSfx();
  const bleepSfxId = bleepSound?.sfxId ?? PROFANITY_BLEEP_SFX_ID;
  const bleepVolumeDb = bleepSound
    ? Math.min(-1, suggestSfxVolumeDb(bleepSound, { baseVolumeDb: -3 }))
    : DEFAULT_BLEEP_VOLUME_DB;

  return censorshipWindows
    .filter((window) => window.mode === "bleep")
    .map((window) => {
      const windowDur = Math.max(0.05, window.endSec - window.startSec);
      const durationSec = bleepSound?.durationSec != null
        ? Math.min(windowDur, bleepSound.durationSec)
        : windowDur;

      return {
        sfxId: bleepSfxId,
        source: "library",
        label: "bleep",
        outputStartSec: window.startSec,
        outputEndSec: window.startSec + durationSec,
        durationSec,
        volumeDb: bleepVolumeDb,
      };
    });
}

export function outputHasAudioCensorship(output) {
  return resolveAudioCensorshipWindows(output).length > 0;
}

/**
 * Volume automation on bed stream for music_swell / music_drop.
 */
export function buildMusicBedMomentVolumeFilter(inputLabel, outputLabel, moment) {
  const { techniqueId, outputStartSec, outputEndSec, params = {} } = moment;
  const start = outputStartSec;
  const end = params.durationSec != null
    ? outputStartSec + params.durationSec
    : outputEndSec;
  const gainDb = params.gainDb ?? (techniqueId === "music_swell"
    ? DEFAULT_SWELL_GAIN_DB
    : DEFAULT_DROP_GAIN_DB);
  const factor = Math.pow(10, gainDb / 20);
  return `${inputLabel}volume=enable='between(t\\,${start}\\,${end})':volume=${factor}${outputLabel}`;
}

/**
 * Brief volume dip on voice stream for silence_beat.
 */
export function buildVoiceMomentVolumeFilter(inputLabel, outputLabel, moment) {
  const { outputStartSec, outputEndSec, params = {} } = moment;
  const start = outputStartSec;
  const end = params.durationSec != null
    ? outputStartSec + params.durationSec
    : outputEndSec;
  const factor = params.volumeFactor ?? DEFAULT_SILENCE_BEAT_VOLUME;
  return `${inputLabel}volume=enable='between(t\\,${start}\\,${end})':volume=${factor}${outputLabel}`;
}

/**
 * Sample rate for asetrate/aresample pitch shift (positive semitones = higher pitch).
 */
export function computePitchShiftSampleRate(semitones, baseRate = DEFAULT_VOICE_SAMPLE_RATE) {
  return Math.round(baseRate * (2 ** (semitones / 12)));
}

/**
 * Time-windowed voice pitch shift via asetrate + aresample (split dry/wet mix).
 * Returns multiple filter_complex fragments to append in order.
 */
export function buildVoicePitchShiftFilter(inputLabel, outputLabel, moment, { id = 0 } = {}) {
  const { outputStartSec, outputEndSec, params = {} } = moment;
  const start = outputStartSec;
  const end = params.durationSec != null
    ? outputStartSec + params.durationSec
    : outputEndSec;
  const semitones = params.semitones ?? 4;
  const rate = computePitchShiftSampleRate(semitones);
  const dryLabel = `[vp${id}d]`;
  const wetInLabel = `[vp${id}w]`;
  const pitchedLabel = `[vp${id}p]`;
  const dryMixLabel = `[vp${id}dm]`;
  const wetMixLabel = `[vp${id}wm]`;
  const windowExpr = `between(t\\,${start}\\,${end})`;

  return [
    `${inputLabel}asplit=2${dryLabel}${wetInLabel}`,
    `${wetInLabel}asetrate=${rate},aresample=${DEFAULT_VOICE_SAMPLE_RATE}${pitchedLabel}`,
    `${pitchedLabel}volume='if(${windowExpr}\\,1\\,0)':eval=frame${wetMixLabel}`,
    `${dryLabel}volume='if(${windowExpr}\\,0\\,1)':eval=frame${dryMixLabel}`,
    `${dryMixLabel}${wetMixLabel}amix=inputs=2:duration=first:dropout_transition=0${outputLabel}`,
  ];
}

/**
 * Short emphasis window: mild pitch lift + gain boost on voice.
 */
export function buildVoiceEmphasisBoostFilter(inputLabel, outputLabel, moment, { id = 0 } = {}) {
  const { outputStartSec, outputEndSec, params = {} } = moment;
  const start = outputStartSec;
  const end = params.durationSec != null
    ? outputStartSec + params.durationSec
    : outputEndSec;
  const semitones = params.semitones ?? 1.5;
  const gainDb = params.gainDb ?? 2;
  const rate = computePitchShiftSampleRate(semitones);
  const gainFactor = Math.pow(10, gainDb / 20);
  const dryLabel = `[ve${id}d]`;
  const wetInLabel = `[ve${id}w]`;
  const pitchedLabel = `[ve${id}p]`;
  const dryMixLabel = `[ve${id}dm]`;
  const wetMixLabel = `[ve${id}wm]`;
  const windowExpr = `between(t\\,${start}\\,${end})`;

  return [
    `${inputLabel}asplit=2${dryLabel}${wetInLabel}`,
    `${wetInLabel}asetrate=${rate},aresample=${DEFAULT_VOICE_SAMPLE_RATE},volume=${gainFactor}${pitchedLabel}`,
    `${pitchedLabel}volume='if(${windowExpr}\\,1\\,0)':eval=frame${wetMixLabel}`,
    `${dryLabel}volume='if(${windowExpr}\\,0\\,1)':eval=frame${dryMixLabel}`,
    `${dryMixLabel}${wetMixLabel}amix=inputs=2:duration=first:dropout_transition=0${outputLabel}`,
  ];
}

function buildVoiceAudioMomentFilters(inputLabel, outputLabel, moment, index) {
  if (moment.techniqueId === "voice_pitch_shift") {
    return buildVoicePitchShiftFilter(inputLabel, outputLabel, moment, { id: index });
  }
  if (moment.techniqueId === "voice_emphasis_boost") {
    return buildVoiceEmphasisBoostFilter(inputLabel, outputLabel, moment, { id: index });
  }
  return [buildVoiceMomentVolumeFilter(inputLabel, outputLabel, moment)];
}

/**
 * Map recipe duckingDb (e.g. -12) to sidechaincompress params.
 * Deeper ducking (more negative) → higher ratio, lower threshold.
 */
export function buildSidechainCompressFilter(duckingDb = DEFAULT_DUCKING_DB) {
  const depthDb = Math.abs(duckingDb ?? DEFAULT_DUCKING_DB);
  const baseDepth = Math.abs(DEFAULT_DUCKING_DB);
  const ratio = Math.min(20, Math.max(2, 6 * (depthDb / baseDepth)));
  const threshold = Math.max(0.01, Math.min(0.15, 0.05 * (baseDepth / depthDb)));
  return `sidechaincompress=threshold=${threshold.toFixed(3)}:ratio=${ratio.toFixed(1)}:attack=50:release=400`;
}

/**
 * Resolve ducking depth windows for a mix segment (output timeline seconds).
 * Falls back to segment.duckingDb, then musicBed.duckingDb, then DEFAULT_DUCKING_DB.
 */
function buildDuckingWindowExpr({ startSec, endSec }) {
  if (endSec == null) {
    return `gte(t\\,${startSec})`;
  }
  return `gte(t\\,${startSec})*lt(t\\,${endSec})`;
}

/**
 * Insert no-duck windows (duckingDb: 0) for gaps between explicit duckingWindows.
 */
export function fillDuckingWindowGaps(windows, segmentEndSec) {
  if (!windows.length) {
    return windows;
  }

  const sorted = [...windows].sort((a, b) => a.startSec - b.startSec);
  const filled = [];

  if (sorted[0].startSec > 0) {
    filled.push({ startSec: 0, endSec: sorted[0].startSec, duckingDb: 0 });
  }

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    filled.push(current);
    const next = sorted[i + 1];
    if (next && current.endSec != null && current.endSec < next.startSec) {
      filled.push({ startSec: current.endSec, endSec: next.startSec, duckingDb: 0 });
    }
  }

  const last = sorted[sorted.length - 1];
  if (last.endSec != null && segmentEndSec != null && last.endSec < segmentEndSec) {
    filled.push({ startSec: last.endSec, endSec: segmentEndSec, duckingDb: 0 });
  }

  return filled;
}

export function resolveDuckingWindows(mixSegment, plan, {
  output = null,
  wordIndexes = null,
} = {}) {
  return resolveDuckingWindowsWithSource(mixSegment, plan, { output, wordIndexes }).windows;
}

/**
 * Same as resolveDuckingWindows, plus provenance for fidelity logs.
 * @returns {{ windows: object[], source: "director"|"speech_derived"|"fallback" }}
 */
export function resolveDuckingWindowsWithSource(mixSegment, plan, {
  output = null,
  wordIndexes = null,
} = {}) {
  const globalDb = plan?.musicBed?.duckingDb ?? DEFAULT_DUCKING_DB;

  if (mixSegment?.duckingWindows?.length) {
    const windows = mixSegment.duckingWindows.map((w) => ({
      startSec: w.startSec,
      endSec: w.endSec,
      duckingDb: w.duckingDb ?? globalDb,
    }));
    return {
      windows: fillDuckingWindowGaps(windows, mixSegment.musicOutSec ?? null),
      source: "director",
    };
  }

  // Deterministic speech fallback when enricher did not materialize windows.
  if (output?.timeline?.length && wordIndexes) {
    const derived = deriveSpeechDuckingWindows(output, {
      wordIndexes,
      speechDuckDb: mixSegment?.duckingDb ?? globalDb,
      endSec: mixSegment?.musicOutSec ?? null,
    });
    if (derived.length) {
      return { windows: derived, source: "speech_derived" };
    }
  }

  const duckingDb = mixSegment?.duckingDb ?? globalDb;
  return {
    windows: [{ startSec: 0, endSec: null, duckingDb }],
    source: "fallback",
  };
}

function buildDuckingWindowMaskFilter(inputLabel, outputLabel, window) {
  const windowExpr = buildDuckingWindowExpr(window);
  return `${inputLabel}volume='if(${windowExpr}\\,1\\,0)':eval=frame${outputLabel}`;
}

/**
 * Duck music bed under voice — single depth or per-window sidechain branches.
 */
export function buildMusicBedDuckingFilters(musicLabel, voiceLabel, duckingWindows) {
  if (duckingWindows.length === 1 && duckingWindows[0].startSec === 0 && duckingWindows[0].endSec == null) {
    const scFilter = buildSidechainCompressFilter(duckingWindows[0].duckingDb);
    return {
      filters: [`${musicLabel}${voiceLabel}${scFilter}[ducked]`],
      outputLabel: "[ducked]",
    };
  }

  const filters = [];
  const branchLabels = duckingWindows.map((_, i) => `[dk${i}]`);
  filters.push(`${musicLabel}asplit=${duckingWindows.length}${branchLabels.join("")}`);

  const maskedLabels = [];
  for (let i = 0; i < duckingWindows.length; i += 1) {
    const window = duckingWindows[i];
    const maskedLabel = `[dk${i}m]`;
    if (window.duckingDb === 0) {
      filters.push(buildDuckingWindowMaskFilter(branchLabels[i], maskedLabel, window));
    } else {
      const scFilter = buildSidechainCompressFilter(window.duckingDb);
      const duckedLabel = `[dk${i}d]`;
      filters.push(`${branchLabels[i]}${voiceLabel}${scFilter}${duckedLabel}`);
      filters.push(buildDuckingWindowMaskFilter(duckedLabel, maskedLabel, window));
    }
    maskedLabels.push(maskedLabel);
  }

  filters.push(
    `${maskedLabels.join("")}amix=inputs=${maskedLabels.length}:duration=first:dropout_transition=0[ducked]`,
  );
  return { filters, outputLabel: "[ducked]" };
}

export function resolveSfxPath(label) {
  if (!label) {
    return null;
  }

  const byId = resolveSfxById(label);
  if (byId.sound) {
    return resolveSfxFilePath(byId.sound);
  }

  const byTag = resolveSfxByTag(label);
  if (byTag.sound) {
    return resolveSfxFilePath(byTag.sound);
  }

  const baseName = label.replace(/^library\/sfx\//, "").replace(/^sfx\//, "");
  for (const ext of [".mp3", ".wav", ".m4a"]) {
    const candidate = path.join(SFX_DIR, `${baseName}${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Build two-pass loudnorm filter string from first-pass measurement.
 */
export function buildLoudnormFilter(measurement, {
  targetLufs = DEFAULT_VOICE_TARGET_LUFS,
  truePeak = -1.5,
  lra = 11,
} = {}) {
  const parts = [
    `I=${targetLufs}`,
    `TP=${truePeak}`,
    `LRA=${lra}`,
    `measured_I=${measurement.integratedLufs}`,
  ];
  if (measurement.truePeakDb != null) {
    parts.push(`measured_TP=${measurement.truePeakDb}`);
  }
  if (measurement.lra != null) {
    parts.push(`measured_LRA=${measurement.lra}`);
  }
  if (measurement.threshold != null) {
    parts.push(`measured_thresh=${measurement.threshold}`);
  }
  if (measurement.targetOffset != null) {
    parts.push(`offset=${measurement.targetOffset}`);
  }
  parts.push("linear=true");
  return `loudnorm=${parts.join(":")}`;
}

/**
 * Build filter_complex graph for voice loudnorm + optional music bed + sfx.
 */
export function buildAudioMixFilterGraph({
  plan,
  mixSegment,
  bedPath,
  sfxEntries = [],
  voiceLoudnormFilter = null,
  musicBedMoments = [],
  voiceAudioMoments = [],
  censorshipWindows = [],
  output = null,
  wordIndexes = null,
}) {
  const filters = [];
  const mixInputs = [];
  let inputCount = 1;

  const voiceNeedsFxChain = voiceAudioMoments.length > 0 || censorshipWindows.length > 0;
  const voiceBaseLabel = voiceNeedsFxChain ? "[voice_base]" : "[voice]";
  if (voiceLoudnormFilter) {
    filters.push(`[0:a]${voiceLoudnormFilter}${voiceBaseLabel}`);
  } else {
    filters.push(`[0:a]anull${voiceBaseLabel}`);
  }

  let voiceLabel = voiceBaseLabel;
  for (let i = 0; i < voiceAudioMoments.length; i += 1) {
    const nextLabel = i === voiceAudioMoments.length - 1 ? "[voice_fx]" : `[voice_m${i}]`;
    filters.push(...buildVoiceAudioMomentFilters(voiceLabel, nextLabel, voiceAudioMoments[i], i));
    voiceLabel = nextLabel;
  }

  if (censorshipWindows.length > 0) {
    const censoredLabel = "[voice]";
    const muteFilter = buildVoiceCensorshipMuteFilter(voiceLabel, censoredLabel, censorshipWindows);
    if (muteFilter) {
      filters.push(muteFilter);
      voiceLabel = censoredLabel;
    }
  } else if (voiceAudioMoments.length > 0) {
    filters.push(`${voiceLabel}anull[voice]`);
    voiceLabel = "[voice]";
  }

  if (voiceLabel !== "[voice]") {
    filters.push(`${voiceLabel}anull[voice]`);
  }

  mixInputs.push("[voice]");

  if (bedPath) {
    const volDb = plan?.musicBed?.volumeDb ?? -18;
    const volume = Math.pow(10, volDb / 20);
    const bedBaseLabel = musicBedMoments.length > 0 ? "[music_base]" : "[music]";
    filters.push(`[${inputCount}:a]volume=${volume}${bedBaseLabel}`);

    let bedLabel = bedBaseLabel;
    for (let i = 0; i < musicBedMoments.length; i += 1) {
      const nextLabel = i === musicBedMoments.length - 1 ? "[music]" : `[music_m${i}]`;
      filters.push(buildMusicBedMomentVolumeFilter(bedLabel, nextLabel, musicBedMoments[i]));
      bedLabel = nextLabel;
    }

    if (mixSegment?.duckUnderVoice !== false) {
      const duckingWindows = resolveDuckingWindows(mixSegment, plan, {
        output,
        wordIndexes,
      });
      const { filters: duckFilters, outputLabel } = buildMusicBedDuckingFilters(
        bedLabel,
        "[voice]",
        duckingWindows,
      );
      filters.push(...duckFilters);
      mixInputs.push(outputLabel);
    } else {
      mixInputs.push("[music]");
    }
    inputCount += 1;
  }

  for (const sfx of sfxEntries) {
    const vol = Math.pow(10, (sfx.volumeDb ?? -6) / 20);
    const delayMs = Math.round((sfx.outputStartSec ?? 0) * 1000);
    const sfxLabel = `sfx${inputCount}`;

    if (sfx.sourcePath != null && sfx.anchorTimeSec != null) {
      const durationSec = sfx.durationSec
        ?? Math.max(0.01, (sfx.outputEndSec ?? 0) - (sfx.outputStartSec ?? 0));
      filters.push(
        `[${inputCount}:a]atrim=start=${sfx.anchorTimeSec}:duration=${durationSec},`
        + `asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},volume=${vol}[${sfxLabel}]`,
      );
    } else {
      const trimDur = sfx.durationSec
        ?? ((sfx.outputEndSec != null && sfx.outputStartSec != null)
          ? Math.max(0.01, sfx.outputEndSec - sfx.outputStartSec)
          : null);
      if (trimDur != null) {
        filters.push(
          `[${inputCount}:a]atrim=0:${trimDur},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},volume=${vol}[${sfxLabel}]`,
        );
      } else {
        filters.push(`[${inputCount}:a]adelay=${delayMs}|${delayMs},volume=${vol}[${sfxLabel}]`);
      }
    }

    mixInputs.push(`[${sfxLabel}]`);
    inputCount += 1;
  }

  const voiceNeedsProcessing = voiceLoudnormFilter
    || voiceAudioMoments.length > 0
    || censorshipWindows.length > 0;

  if (mixInputs.length === 1 && !voiceNeedsProcessing) {
    return { filters: [], mixInputs, inputCount: 0, needsMix: false };
  }

  if (mixInputs.length === 1 && voiceNeedsProcessing) {
    return { filters, mixInputs: ["[voice]"], inputCount: 0, needsMix: true, voiceOnly: true };
  }

  filters.push(`${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=2[aout]`);
  return { filters, mixInputs, inputCount, needsMix: true, outputLabel: "[aout]" };
}

/**
 * Resolve sfxPlan entries for mixing: library files or audio_event clip excerpts.
 */
export function resolveSfxPlanEntries(sfxPlan = [], context, mixSegment) {
  const warnings = [];
  const sfxEntries = [];
  const musicOutSec = mixSegment?.musicOutSec ?? 99999;

  for (const sfx of sfxPlan) {
    if (sfx.outputStartSec >= musicOutSec) {
      continue;
    }

    if (sfx.source === "audio_event") {
      const clip = context?.clips?.[sfx.clipId];
      const sourcePath = clip?.sourcePath && fs.existsSync(clip.sourcePath)
        ? clip.sourcePath
        : null;

      if (sfx.anchorTimeSec == null) {
        warnings.push({
          code: "SFX_UNRESOLVED",
          sfxId: sfx.sfxId,
          source: "audio_event",
          message: `audio_event ${sfx.sfxId}: brak anchorTimeSec`,
        });
        continue;
      }

      if (!sourcePath) {
        warnings.push({
          code: "SFX_UNRESOLVED",
          sfxId: sfx.sfxId,
          source: "audio_event",
          clipId: sfx.clipId,
          message: `audio_event ${sfx.sfxId}: brak pliku źródłowego dla clipId ${sfx.clipId ?? "(brak)"}`,
        });
        continue;
      }

      sfxEntries.push({
        ...sfx,
        sourcePath,
        durationSec: Math.max(0.01, sfx.outputEndSec - sfx.outputStartSec),
      });
      continue;
    }

    const resolvedPath = resolveSfxPath(sfx.sfxId) ?? resolveSfxPath(sfx.label);
    if (!resolvedPath) {
      warnings.push({
        code: "SFX_UNRESOLVED",
        sfxId: sfx.sfxId,
        source: sfx.source ?? "library",
        message: `library ${sfx.sfxId}: nie znaleziono pliku SFX (${sfx.label ?? sfx.sfxId})`,
      });
      continue;
    }

    sfxEntries.push({ ...sfx, resolvedPath });
  }

  return { sfxEntries, warnings };
}

/**
 * Mix voice with music bed and optional sfxPlan overlays.
 */
export async function applyAudioMix(inputPath, outputPath, {
  recipe,
  output,
  context,
  creativeMoments = [],
  encodeProfile,
  measureLoudnessFn = measureLoudness,
  runFfmpegFn = runFfmpeg,
}) {
  const plan = recipe.audioMixPlan;
  const mixSegment = plan?.segments?.find((s) => s.outputId === output.outputId);
  const bed = context.musicBed ?? (plan?.musicBed?.trackId
    ? resolveTrackById(plan.musicBed.trackId).track
    : null);

  const bedPath = bed?.fileName
    ? resolveTrackFilePath(bed)
    : context.musicBed?.trackFilePath;

  const resolvedBedPath = bedPath && fs.existsSync(bedPath) ? bedPath : null;
  const musicBedMoments = resolvedBedPath
    ? resolveMusicBedMoments(creativeMoments)
    : [];
  const voiceAudioMoments = resolveVoiceAudioMoments(creativeMoments);

  const censorshipWindows = resolveAudioCensorshipWindows(output);
  const bleepEntries = resolveBleepSfxEntries(censorshipWindows);
  const { sfxEntries: planSfxEntries, warnings: sfxWarnings } = resolveSfxPlanEntries(
    recipe.sfxPlan ?? [],
    context,
    mixSegment,
  );
  const { sfxEntries: bleepSfxEntries, warnings: bleepWarnings } = resolveSfxPlanEntries(
    bleepEntries,
    context,
    mixSegment,
  );
  const sfxEntries = [...planSfxEntries, ...bleepSfxEntries];
  const sfxWarningsCombined = [...sfxWarnings, ...bleepWarnings];

  const voiceTargetLufs = plan?.voiceTargetLufs ?? DEFAULT_VOICE_TARGET_LUFS;
  let voiceLoudnormFilter = null;

  if (plan) {
    try {
      const measurement = await measureLoudnessFn(inputPath, { targetLufs: voiceTargetLufs });
      voiceLoudnormFilter = buildLoudnormFilter(measurement, { targetLufs: voiceTargetLufs });
    } catch {
      voiceLoudnormFilter = `loudnorm=I=${voiceTargetLufs}:TP=-1.5:LRA=11:linear=true`;
    }
  }

  const graph = buildAudioMixFilterGraph({
    plan,
    mixSegment,
    bedPath: resolvedBedPath,
    sfxEntries,
    voiceLoudnormFilter,
    musicBedMoments,
    voiceAudioMoments,
    censorshipWindows,
    output,
    wordIndexes: context?.wordIndexes ?? null,
  });

  const appliedAudioTechniques = [
    ...musicBedMoments.map((m) => m.techniqueId),
    ...voiceAudioMoments.map((m) => m.techniqueId),
  ];
  const audioTechniquesApplied = appliedAudioTechniques.length > 0;

  let duckingWindowCount = 0;
  let duckingSource = null;
  if (resolvedBedPath && mixSegment?.duckUnderVoice !== false) {
    const ducking = resolveDuckingWindowsWithSource(mixSegment, plan, {
      output,
      wordIndexes: context?.wordIndexes ?? null,
    });
    duckingWindowCount = ducking.windows.length;
    duckingSource = ducking.source;
  }

  if (!graph.needsMix) {
    fs.copyFileSync(inputPath, outputPath);
    return {
      outputPath,
      applied: false,
      sfxApplied: false,
      audioTechniquesApplied: false,
      appliedAudioTechniques: [],
      duckingWindowCount: 0,
      duckingSource: null,
      warnings: sfxWarningsCombined,
    };
  }

  const args = ["-y", "-i", inputPath];
  let nextInput = 1;

  if (resolvedBedPath) {
    const musicIn = mixSegment?.musicInSec ?? 0;
    args.push("-ss", String(musicIn), "-i", resolvedBedPath);
    nextInput += 1;
  }

  for (const sfx of sfxEntries) {
    args.push("-i", sfx.sourcePath ?? sfx.resolvedPath);
    nextInput += 1;
  }

  const audioMap = graph.voiceOnly ? "[voice]" : graph.outputLabel;

  await runFfmpegFn(
    [
      ...args,
      "-filter_complex", graph.filters.join(";"),
      "-map", "0:v",
      "-map", audioMap,
      "-c:v", "copy",
      "-c:a", encodeProfile.audioCodec,
      "-b:a", encodeProfile.audioBitrate,
      outputPath,
    ],
    { label: "audio mix" },
  );

  return {
    outputPath,
    applied: true,
    sfxApplied: sfxEntries.length > 0,
    audioTechniquesApplied,
    appliedAudioTechniques,
    duckingWindowCount,
    duckingSource,
    warnings: sfxWarningsCombined,
  };
}
