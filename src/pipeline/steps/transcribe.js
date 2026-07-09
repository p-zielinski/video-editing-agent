import fs from "node:fs";
import path from "node:path";
import {
  extractAudioForWhisper,
  extractAudioChunksForWhisper,
  whisperAudioPath,
} from "../../lib/extract-audio.js";
import {
  transcribeForEdit,
  transcribeChunksForEdit,
  buildWhisperPrompt,
} from "../../lib/transcribe.js";
import { tagFillerWords, tagProfanityWords } from "../../lib/srt-processor.js";
import { applyExpectedTermCorrections } from "../../lib/transcript-correction.js";
import { assignWordIds, WordIndexSchema } from "../../schemas/word-index.js";
import { resolveClipContentHash } from "../../lib/clip-artifact-cache.js";
import { buildStepConfigFingerprint } from "../../lib/config-fingerprint.js";
import {
  maybeUseGlobalClipCache,
  publishGlobalClipArtifact,
} from "../../lib/global-cache-step.js";
import { getClipConcurrencyLimit, runWithConcurrency } from "../../lib/clip-concurrency.js";
import { writeJson, readJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact } from "../artifact-deps.js";

const WHISPER_MAX_BYTES = 24 * 1024 * 1024;

function resolveExpectedTerms(manifest) {
  const fromManifest = manifest?.batchContext?.expectedTerms;
  if (Array.isArray(fromManifest) && fromManifest.length > 0) {
    return fromManifest;
  }
  return [];
}

function resolveProfanityOptions(manifest) {
  const batchContext = manifest?.batchContext ?? {};
  return {
    profanityPolicy: batchContext.profanityPolicy ?? "bleep",
    profanitySubtitleMode: batchContext.profanitySubtitleMode ?? "partial",
  };
}

export async function transcribeClip({
  workDir,
  clip,
  apiKey,
  force = false,
  globalCacheDisabled = false,
  manifest = null,
  configFingerprint,
}) {
  const outPath = path.join(workDir, ARTIFACTS.words(clip.clipId));
  if (force) {
    removeClipArtifact(outPath);
  }
  if (shouldUseCachedClipArtifact(workDir, outPath, force, {
    manifest,
    clipId: clip.clipId,
  })) {
    return readJson(outPath);
  }

  const expectedTerms = resolveExpectedTerms(manifest);
  const resolvedFingerprint = configFingerprint
    ?? buildStepConfigFingerprint("words", { expectedTerms });
  const sourceContentHash = await resolveClipContentHash(manifest, clip.clipId, clip.sourcePath);
  const cachedWords = maybeUseGlobalClipCache({
    enabled: !globalCacheDisabled,
    step: "words",
    contentHash: sourceContentHash,
    configFingerprint: resolvedFingerprint,
    clipId: clip.clipId,
    disabled: globalCacheDisabled,
  });

  if (cachedWords) {
    const wordIndex = WordIndexSchema.parse(
      sourceContentHash ? { ...cachedWords, sourceContentHash } : cachedWords,
    );
    writeJson(outPath, wordIndex);
    return wordIndex;
  }

  const audioPath = whisperAudioPath(workDir, clip.clipId);

  await extractAudioForWhisper(clip.sourcePath, audioPath);

  const whisperPrompt = buildWhisperPrompt({ expectedTerms });

  let words;
  let durationSec;

  if (fs.statSync(audioPath).size > WHISPER_MAX_BYTES) {
    const chunks = await extractAudioChunksForWhisper(clip.sourcePath, workDir, {
      clipId: clip.clipId,
    });
    const result = await transcribeChunksForEdit(chunks, apiKey, { prompt: whisperPrompt });
    words = result.words;
    durationSec = result.duration;
  } else {
    const result = await transcribeForEdit(audioPath, apiKey, { prompt: whisperPrompt });
    words = result.words;
    durationSec = result.duration ?? clip.durationSec;
  }

  const profanityOptions = resolveProfanityOptions(manifest);
  const tagged = tagFillerWords(words);
  const profanityTagged = tagProfanityWords(tagged, {
    profanityPolicy: profanityOptions.profanityPolicy,
    subtitleMode: profanityOptions.profanitySubtitleMode,
  });
  const corrected = applyExpectedTermCorrections(profanityTagged, expectedTerms);
  const withIds = assignWordIds(corrected, clip.clipId);

  const wordIndex = WordIndexSchema.parse({
    version: "1.0",
    clipId: clip.clipId,
    words: withIds,
    durationSec,
  });

  const artifact = sourceContentHash ? { ...wordIndex, sourceContentHash } : wordIndex;
  writeJson(outPath, artifact);

  if (sourceContentHash) {
    publishGlobalClipArtifact({
      step: "words",
      contentHash: sourceContentHash,
      configFingerprint: resolvedFingerprint,
      artifact,
      disabled: globalCacheDisabled,
    });
  }

  return artifact;
}

export async function runTranscribeStep({
  workDir,
  apiKey,
  force = false,
  globalCacheDisabled = false,
}) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  const expectedTerms = resolveExpectedTerms(manifest);
  const configFingerprint = buildStepConfigFingerprint("words", { expectedTerms });

  return runWithConcurrency(
    catalog.clips,
    (clip) => transcribeClip({
      workDir,
      clip,
      apiKey,
      force,
      globalCacheDisabled,
      manifest,
      configFingerprint,
    }),
    { limit: getClipConcurrencyLimit(), label: "transcribe" },
  );
}
