import fs from "node:fs";
import path from "node:path";
import {
  extractAudioForWhisper,
  extractAudioChunksForWhisper,
  whisperAudioPath,
} from "../../lib/extract-audio.js";
import { transcribeForEdit, transcribeChunksForEdit } from "../../lib/transcribe.js";
import { tagFillerWords } from "../../lib/srt-processor.js";
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

  const resolvedFingerprint = configFingerprint ?? buildStepConfigFingerprint("words", {});
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

  let words;
  let durationSec;

  if (fs.statSync(audioPath).size > WHISPER_MAX_BYTES) {
    const chunks = await extractAudioChunksForWhisper(clip.sourcePath, workDir, {
      clipId: clip.clipId,
    });
    const result = await transcribeChunksForEdit(chunks, apiKey);
    words = result.words;
    durationSec = result.duration;
  } else {
    const result = await transcribeForEdit(audioPath, apiKey);
    words = result.words;
    durationSec = result.duration ?? clip.durationSec;
  }

  const tagged = tagFillerWords(words);
  const withIds = assignWordIds(tagged, clip.clipId);

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
  const configFingerprint = buildStepConfigFingerprint("words", {});

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
