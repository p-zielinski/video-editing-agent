import fs from "node:fs";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import { createOpenAIFetch } from "../agents/openai-client.js";
import { createLogger, formatFileSize } from "./logger.js";
import { cleanWhisperWords } from "./srt-processor.js";
import { formatWhisperFailure } from "./whisper-errors.js";

const whisperLog = createLogger("whisper");

const WHISPER_MAX_ATTEMPTS = 4;
const WHISPER_TIMEOUT_MS = 15 * 60 * 1000;

/** @deprecated Prefer createOpenAIFetch from openai-client.js */
export function createWhisperFetch() {
  return createOpenAIFetch();
}

export const WHISPER_EDIT_PROMPT =
  "Transkrybuj dosłownie wszystko co zostało powiedziane po polsku. Zapisz każde słowo, włącznie z zająknięciami: yyy, eee, ooo, mmm, um, aha, ach, hm. Nie poprawiaj tekstu, nie skracaj powtórek. Zachowaj angielskie nazwy własne i marki w oryginalnej pisowni, gdy są wypowiadane w zdaniach po polsku. Zapisuj wulgaryzmy dosłownie, bez eufemizmów ani cenzury.";

export const OPENAI_WHISPER_MODEL_DEFAULT = "whisper-1";

export function resolveOpenAIWhisperModel() {
  return process.env.OPENAI_WHISPER_MODEL ?? OPENAI_WHISPER_MODEL_DEFAULT;
}

export function buildWhisperPrompt({ expectedTerms = [] } = {}) {
  const terms = [...new Set(
    expectedTerms
      .map((term) => String(term).trim())
      .filter(Boolean),
  )];

  if (terms.length === 0) {
    return WHISPER_EDIT_PROMPT;
  }

  return `${WHISPER_EDIT_PROMPT} Oczekiwane terminy (zachowaj pisownię): ${terms.join(", ")}.`;
}

function isRetryableWhisperError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /premature close|econnreset|etimedout|socket hang up|fetch failed|network|timeout/i.test(
    message,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function audioFileForUpload(audioPath) {
  const buffer = fs.readFileSync(audioPath);
  return toFile(buffer, path.basename(audioPath), { type: "audio/mpeg" });
}

async function callWhisperTranscription(audioPath, apiKey, prompt, { wordTimestamps = true } = {}) {
  const openai = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: WHISPER_TIMEOUT_MS,
    fetch: createOpenAIFetch(),
  });

  const request = {
    file: await audioFileForUpload(audioPath),
    model: resolveOpenAIWhisperModel(),
    language: "pl",
    response_format: "verbose_json",
    prompt,
  };

  if (wordTimestamps) {
    request.timestamp_granularities = ["word"];
  }

  return openai.audio.transcriptions.create(request);
}

async function transcribeWithRetry(audioPath, apiKey, prompt, options = {}) {
  const { wordTimestamps = true } = options;
  let lastError;

  for (let attempt = 1; attempt <= WHISPER_MAX_ATTEMPTS; attempt++) {
    try {
      return await callWhisperTranscription(audioPath, apiKey, prompt, { wordTimestamps });
    } catch (error) {
      lastError = error;
      const canRetry =
        attempt < WHISPER_MAX_ATTEMPTS && isRetryableWhisperError(error);

      if (!canRetry) {
        break;
      }

      const delayMs = 2000 * attempt;
      whisperLog.warn(
        `błąd sieci/API (${error.message}) — ponawiam za ${delayMs / 1000} s (${attempt}/${WHISPER_MAX_ATTEMPTS})`,
      );
      await sleep(delayMs);
    }
  }

  if (wordTimestamps) {
    whisperLog.warn("znaczniki słów niedostępne — ponawiam bez word timestamps (segmenty)");
    return transcribeWithRetry(audioPath, apiKey, prompt, { wordTimestamps: false });
  }

  const wrapped = new Error(formatWhisperFailure(lastError));
  wrapped.cause = lastError;
  throw wrapped;
}

function offsetWords(words, offsetSec) {
  return words.map((entry) => ({
    ...entry,
    start: entry.start + offsetSec,
    end: entry.end + offsetSec,
  }));
}

function segmentsToWords(segments) {
  const words = [];

  for (const segment of segments) {
    const segmentWords = segment.text.trim().split(/\s+/).filter(Boolean);
    if (segmentWords.length === 0) {
      continue;
    }

    const segmentDuration = segment.end - segment.start;
    const step = segmentDuration / segmentWords.length;

    segmentWords.forEach((word, index) => {
      words.push({
        word,
        start: segment.start + step * index,
        end: segment.start + step * (index + 1),
      });
    });
  }

  return words;
}

export function wordsFromWhisperResponse(transcription) {
  if (Array.isArray(transcription.words) && transcription.words.length > 0) {
    return cleanWhisperWords(transcription.words, transcription.segments ?? []);
  }

  if (Array.isArray(transcription.segments) && transcription.segments.length > 0) {
    return cleanWhisperWords(segmentsToWords(transcription.segments), transcription.segments);
  }

  return [];
}

export async function transcribeForEdit(
  audioPath,
  apiKey,
  { timeOffsetSec = 0, prompt = WHISPER_EDIT_PROMPT, returnRaw = false } = {},
) {
  const fileSize = fs.statSync(audioPath).size;
  whisperLog.detail(`plik audio: ${formatFileSize(fileSize)}`);

  const transcription = await whisperLog.track(
    "whisper edycja (dosłowna transkrypcja)",
    () => transcribeWithRetry(audioPath, apiKey, prompt),
    { heartbeatSec: 15 },
  );

  const words = wordsFromWhisperResponse(transcription);
  if (words.length === 0) {
    throw new Error("Whisper (edycja) nie zwrócił znaczników słów.");
  }

  const offsetWordsResult = timeOffsetSec > 0 ? offsetWords(words, timeOffsetSec) : words;

  if (returnRaw) {
    return {
      words: offsetWordsResult,
      duration: transcription.duration,
      raw: transcription,
    };
  }

  return {
    words: offsetWordsResult,
    duration: transcription.duration,
  };
}

export async function transcribeChunksForEdit(chunks, apiKey, { prompt = WHISPER_EDIT_PROMPT } = {}) {
  const allWords = [];
  let maxDuration = 0;

  for (const chunk of chunks) {
    const result = await transcribeForEdit(chunk.path, apiKey, {
      timeOffsetSec: chunk.startSec,
      prompt,
    });
    allWords.push(...result.words);
    maxDuration = Math.max(maxDuration, chunk.endSec);
  }

  allWords.sort((a, b) => a.start - b.start);

  return {
    words: allWords,
    duration: maxDuration,
  };
}
