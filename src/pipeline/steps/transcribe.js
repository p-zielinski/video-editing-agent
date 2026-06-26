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
import { writeJson, readJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact } from "../artifact-deps.js";

const WHISPER_MAX_BYTES = 24 * 1024 * 1024;

export async function runTranscribeStep({ workDir, apiKey, force = false }) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const results = [];

  for (const clip of catalog.clips) {
    const outPath = path.join(workDir, ARTIFACTS.words(clip.clipId));
    if (force) {
      removeClipArtifact(outPath);
    }
    if (shouldUseCachedClipArtifact(workDir, outPath, force)) {
      results.push(readJson(outPath));
      continue;
    }

    const audioPath = whisperAudioPath(workDir, clip.clipId);

    await extractAudioForWhisper(clip.sourcePath, audioPath);

    let words;
    let durationSec;

    if (fs.statSync(audioPath).size > WHISPER_MAX_BYTES) {
      const chunks = await extractAudioChunksForWhisper(clip.sourcePath, workDir);
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

    writeJson(outPath, wordIndex);
    results.push(wordIndex);
  }

  return results;
}
