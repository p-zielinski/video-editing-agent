export const PROFANITY_BLEEP_SFX_ID = "bleep_censor_01";
export const PROFANITY_BLEEP_FALLBACK_IDS = [
  "pixabay_sfx_88052",
  "pixabay_sfx_372459",
];

const VOICE_TARGET_LUFS = -16;
const DEFAULT_SFX_VOLUME_DB = -6;

/**
 * Infer editorial tags from title when ingest missed them.
 * @param {object} sound
 */
export function getEffectiveSfxTags(sound) {
  const tags = new Set(sound?.tags ?? []);
  const title = String(sound?.title ?? "").toLowerCase();

  if (/censor|bleep/.test(title)) {
    tags.add("bleep");
    tags.add("alert");
  }
  if (/\bbeep\b|bip\b/.test(title) && !/censor/.test(title)) {
    tags.add("alert");
  }
  if (/notification|notify|ping/.test(title)) {
    tags.add("notification");
    tags.add("alert");
  }
  if (/whoosh|swoosh|swipe/.test(title)) {
    tags.add("whoosh");
  }
  if (/applause|clap|cheer/.test(title)) {
    tags.add("applause");
  }
  if (/laugh/.test(title)) {
    tags.add("laughter");
  }
  if (/impact|hit|thump|bang|pop/.test(title)) {
    tags.add("impact");
  }
  if (/thunder|rain|wind|ambient/.test(title)) {
    tags.add("weather");
  }

  return [...tags];
}

export function isProfanityBleepCandidate(sound) {
  const title = String(sound?.title ?? "").toLowerCase();
  const tags = getEffectiveSfxTags(sound);
  if (sound?.sfxId === PROFANITY_BLEEP_SFX_ID) {
    return true;
  }
  if (PROFANITY_BLEEP_FALLBACK_IDS.includes(sound?.sfxId)) {
    return true;
  }
  return tags.includes("bleep") || /censor/.test(title);
}

/**
 * Suggest overlay volume (dB) from measured LUFS vs voice bed target.
 */
export function suggestSfxVolumeDb(sound, {
  voiceTargetLufs = VOICE_TARGET_LUFS,
  baseVolumeDb = DEFAULT_SFX_VOLUME_DB,
} = {}) {
  if (!Number.isFinite(sound?.integratedLufs)) {
    return baseVolumeDb;
  }
  const loudnessDelta = voiceTargetLufs - sound.integratedLufs;
  return Math.round((baseVolumeDb + loudnessDelta * 0.35) * 10) / 10;
}

function scoreTagMatch(sound, tag) {
  const normalized = String(tag).toLowerCase();
  const tags = getEffectiveSfxTags(sound);
  let score = 0;
  if (tags.includes(normalized)) {
    score += 10;
  }
  const title = String(sound.title ?? "").toLowerCase();
  if (normalized === "bleep" && /censor/.test(title)) {
    score += 20;
  }
  if (normalized === "notification" && /notification|notify/.test(title)) {
    score += 20;
  }
  if (normalized === "whoosh" && /whoosh|swoosh/.test(title)) {
    score += 20;
  }
  if (normalized === "alert" && /beep|bip/.test(title) && !/censor/.test(title)) {
    score += 8;
  }
  if (Number.isFinite(sound.durationSec)) {
    score -= sound.durationSec * 0.5;
  }
  return score;
}

/**
 * @param {object[]} sounds — available catalog entries only
 * @param {string} tag
 */
export function pickBestSfxByTagFromSounds(sounds, tag) {
  const normalized = String(tag).toLowerCase();
  const candidates = sounds.filter((sound) =>
    getEffectiveSfxTags(sound).includes(normalized),
  );

  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort(
    (a, b) => scoreTagMatch(b, normalized) - scoreTagMatch(a, normalized),
  )[0];
}

/**
 * Director-facing library summary (only sounds with files on disk).
 */
export function summarizeSfxForDirector(sounds) {
  return sounds.map((sound) => ({
    sfxId: sound.sfxId,
    title: sound.title ?? sound.sfxId,
    description: sound.description ?? null,
    useCases: sound.useCases ?? [],
    tags: getEffectiveSfxTags(sound),
    category: sound.category ?? null,
    durationSec: sound.durationSec ?? null,
    integratedLufs: sound.integratedLufs ?? null,
    loudnessCharacter: sound.loudnessCharacter ?? null,
    isLoop: sound.isLoop === true,
    suggestedVolumeDb: suggestSfxVolumeDb(sound),
    profanityBleep: isProfanityBleepCandidate(sound),
  }));
}
