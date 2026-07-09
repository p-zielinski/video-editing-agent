import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUDIO_LABEL_PATTERNS } from "../editorial/audio-event-tags.js";
import { getEffectiveSfxTags } from "../editorial/sfx-catalog-summary.js";
import { loadPrompt } from "../agents/openai-client.js";
import { probeDuration, runFfmpeg } from "./ffmpeg.js";

export const ALLOWED_SFX_CATEGORIES = new Set(["transition", "foley", "reaction", "ambience"]);

export const ALLOWED_SFX_EDITORIAL_TAGS = new Set([
  ...AUDIO_LABEL_PATTERNS.map((pattern) => pattern.tag),
  "whoosh",
  "notification",
  "bleep",
]);

const DEFAULT_AUDIO_SAMPLE_SEC = 12;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_SFX_AUDIO_MODEL = "gpt-4o-mini-audio-preview";
const DEFAULT_SFX_TEXT_MODEL = "gpt-5.4-nano";
export const SFX_TEXT_MODEL_FALLBACKS = [DEFAULT_SFX_TEXT_MODEL, "gpt-5.4-mini"];

const unavailableSfxEnrichModels = new Set();
let preferredSfxEnrichTextModel = null;

export function resetSfxEnrichModelCache() {
  unavailableSfxEnrichModels.clear();
  preferredSfxEnrichTextModel = null;
}

export function markSfxEnrichModelUnavailable(model) {
  if (model) {
    unavailableSfxEnrichModels.add(model);
  }
}

export function getAvailableSfxEnrichTextModels() {
  const models = resolveSfxEnrichTextModels()
    .filter((entry) => !unavailableSfxEnrichModels.has(entry));
  if (preferredSfxEnrichTextModel && models.includes(preferredSfxEnrichTextModel)) {
    return [
      preferredSfxEnrichTextModel,
      ...models.filter((entry) => entry !== preferredSfxEnrichTextModel),
    ];
  }
  return models;
}

/**
 * Pick first working text model once per process (avoids 404 spam on every SFX).
 */
export async function probeSfxEnrichTextModel(client) {
  if (preferredSfxEnrichTextModel) {
    return preferredSfxEnrichTextModel;
  }

  for (const model of resolveSfxEnrichTextModels()) {
    if (unavailableSfxEnrichModels.has(model)) {
      continue;
    }
    try {
      await client.chat.completions.create({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      });
      preferredSfxEnrichTextModel = model;
      return model;
    } catch (error) {
      if (isModelUnavailableError(error)) {
        if (!unavailableSfxEnrichModels.has(model)) {
          console.warn(`[sfx-enrich] model ${model} niedostępny — pomijam w batchu`);
        }
        markSfxEnrichModelUnavailable(model);
      }
    }
  }

  return getAvailableSfxEnrichTextModels()[0] ?? null;
}

export function resolveSfxEnrichTextModels() {
  const models = [];
  const preferred = process.env.OPENAI_MODEL_SFX_ENRICH_TEXT
    ?? process.env.OPENAI_MODEL_NANO;
  if (preferred) {
    models.push(preferred);
  }
  for (const fallback of SFX_TEXT_MODEL_FALLBACKS) {
    if (!models.includes(fallback)) {
      models.push(fallback);
    }
  }
  return models;
}

export function resolveSfxEnrichModel({ textOnly = false } = {}) {
  if (textOnly) {
    return resolveSfxEnrichTextModels()[0];
  }
  return process.env.OPENAI_MODEL_SFX_ENRICH ?? DEFAULT_SFX_AUDIO_MODEL;
}

function isNonAudioPreviewModel(modelName) {
  const model = String(modelName ?? "").toLowerCase();
  return model.length > 0
    && !model.includes("audio")
    && !model.includes("realtime");
}

export function warnIfSfxEnrichModelMismatch({ textOnly = false } = {}) {
  if (textOnly) {
    return;
  }
  const audioModel = resolveSfxEnrichModel({ textOnly: false });
  if (isNonAudioPreviewModel(audioModel)) {
    console.warn(
      `[sfx-enrich] OPENAI_MODEL_SFX_ENRICH=${audioModel} nie obsługuje input_audio. `
      + "Ustaw gpt-4o-mini-audio-preview lub użyj --text-only.",
    );
  }
}

function isAudioInputUnsupportedError(error) {
  const message = String(error?.message ?? error ?? "");
  return /content blocks are expected to be either text or image_url/i.test(message)
    || /input_audio/i.test(message) && /invalid/i.test(message);
}

function isModelUnavailableError(error) {
  const message = String(error?.message ?? error ?? "");
  const status = error?.status ?? error?.statusCode;
  return status === 404
    || /does not exist or you do not have access/i.test(message)
    || /premature close/i.test(message)
    || isAudioInputUnsupportedError(error);
}

async function callSfxEnrichOnce(client, {
  sound,
  audioFilePath = null,
  model,
  systemPrompt,
  useAudio = false,
  onUsage,
}) {
  const system = systemPrompt ?? loadPrompt("sfx-enricher", { version: "v1" });
  const userText = buildSfxEnrichUserText(sound);

  /** @type {Array<object>} */
  const userContent = [{ type: "text", text: userText }];

  if (useAudio && audioFilePath && fs.existsSync(audioFilePath)) {
    userContent.push({
      type: "input_audio",
      input_audio: {
        data: readAudioBase64(audioFilePath),
        format: resolveAudioFormat(audioFilePath),
      },
    });
  }

  /** @type {Record<string, unknown>} */
  const request = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  };

  if (useAudio) {
    request.modalities = ["text"];
  }

  const response = await client.chat.completions.create(request);

  if (typeof onUsage === "function" && response.usage) {
    onUsage({ model, usage: response.usage });
  }

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Pusta odpowiedź modelu SFX enricher");
  }

  const parsed = JSON.parse(content);
  return normalizeSfxAiEnrichment(parsed);
}

function normalizeTag(tag) {
  return String(tag ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeCategory(category) {
  const normalized = String(category ?? "").trim().toLowerCase();
  return ALLOWED_SFX_CATEGORIES.has(normalized) ? normalized : null;
}

function normalizeLoudnessCharacter(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "quiet" || normalized === "medium" || normalized === "loud") {
    return normalized;
  }
  return null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function inferLoudnessCharacter(integratedLufs) {
  if (!Number.isFinite(integratedLufs)) {
    return null;
  }
  if (integratedLufs >= -10) {
    return "loud";
  }
  if (integratedLufs >= -18) {
    return "medium";
  }
  return "quiet";
}

/**
 * @param {unknown} raw
 */
export function normalizeSfxAiEnrichment(raw) {
  const description = String(raw?.description ?? "").trim();
  const tags = uniqueStrings(
    (Array.isArray(raw?.tags) ? raw.tags : [])
      .map(normalizeTag)
      .filter((tag) => ALLOWED_SFX_EDITORIAL_TAGS.has(tag)),
  );
  const category = normalizeCategory(raw?.category);
  const useCases = uniqueStrings(
    (Array.isArray(raw?.useCases) ? raw.useCases : [])
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean),
  ).slice(0, 4);
  const loudnessCharacter = normalizeLoudnessCharacter(raw?.loudnessCharacter);
  const isLoop = raw?.isLoop === true;

  if (!description) {
    return null;
  }

  return {
    description,
    tags,
    ...(category ? { category } : {}),
    useCases,
    ...(loudnessCharacter ? { loudnessCharacter } : {}),
    isLoop,
  };
}

export function buildSfxEnrichUserText(sound, { integratedLufs = sound.integratedLufs } = {}) {
  const pixabayTags = sound.pixabay?.tags ?? [];
  const lines = [
    `sfxId: ${sound.sfxId}`,
    `title: ${sound.title ?? sound.sfxId}`,
    `fileName: ${sound.fileName}`,
    `durationSec: ${sound.durationSec ?? "?"}`,
    `integratedLufs: ${integratedLufs ?? "?"}`,
    `currentTags: ${(sound.tags ?? []).join(", ") || "(brak)"}`,
    `pixabayTags: ${pixabayTags.join(", ") || "(brak)"}`,
    `category: ${sound.category ?? "?"}`,
  ];
  if (sound.sourceUrl) {
    lines.push(`sourceUrl: ${sound.sourceUrl}`);
  }
  return lines.join("\n");
}

function resolveAudioFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") {
    return "wav";
  }
  if (ext === ".m4a") {
    return "m4a";
  }
  return "mp3";
}

/**
 * Trim long SFX to a short sample for the audio model.
 */
export async function prepareSfxAudioSample(filePath, {
  maxSec = DEFAULT_AUDIO_SAMPLE_SEC,
  runFfmpegFn = runFfmpeg,
  probeDurationFn = probeDuration,
} = {}) {
  const durationSec = await probeDurationFn(filePath);
  if (durationSec <= maxSec + 0.25) {
    return { samplePath: filePath, cleanup: null, durationSec };
  }

  const samplePath = path.join(
    os.tmpdir(),
    `vea-sfx-enrich-${process.pid}-${Date.now()}.wav`,
  );
  await runFfmpegFn(
    ["-y", "-i", filePath, "-t", String(maxSec), "-ac", "1", "-ar", "24000", samplePath],
    { label: "sfx enrich sample" },
  );
  return {
    samplePath,
    cleanup: () => {
      if (fs.existsSync(samplePath)) {
        fs.unlinkSync(samplePath);
      }
    },
    durationSec,
  };
}

function readAudioBase64(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_AUDIO_BYTES) {
    throw new Error(`Plik audio za duży do analizy AI: ${filePath}`);
  }
  return fs.readFileSync(filePath).toString("base64");
}

/**
 * Call OpenAI with optional audio input; falls back across models when unavailable.
 */
export async function describeSfxWithAi(client, {
  sound,
  audioFilePath = null,
  model,
  systemPrompt,
  textOnly = false,
  onUsage,
} = {}) {
  const hasAudioFile = Boolean(audioFilePath && fs.existsSync(audioFilePath));
  const wantAudio = !textOnly && hasAudioFile;

  /** @type {Array<{ model: string, useAudio: boolean }>} */
  const attempts = [];
  if (wantAudio) {
    attempts.push({
      model: model ?? resolveSfxEnrichModel({ textOnly: false }),
      useAudio: true,
    });
  }
  for (const textModel of getAvailableSfxEnrichTextModels()) {
    if (!attempts.some((entry) => entry.model === textModel)) {
      attempts.push({ model: textModel, useAudio: false });
    }
  }

  let lastError = null;
  for (const attempt of attempts) {
    if (unavailableSfxEnrichModels.has(attempt.model)) {
      continue;
    }
    try {
      const result = await callSfxEnrichOnce(client, {
        sound,
        audioFilePath,
        model: attempt.model,
        systemPrompt,
        useAudio: attempt.useAudio,
        onUsage,
      });
      if (!attempt.useAudio) {
        preferredSfxEnrichTextModel = attempt.model;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!isModelUnavailableError(error)) {
        throw error;
      }
      if (!unavailableSfxEnrichModels.has(attempt.model)) {
        const mode = attempt.useAudio ? "audio" : "text";
        console.warn(`[sfx-enrich] model ${attempt.model} (${mode}) niedostępny — ${error.message}`);
      }
      markSfxEnrichModelUnavailable(attempt.model);
    }
  }

  throw lastError ?? new Error("Brak dostępnego modelu SFX enricher");
}

/**
 * Merge AI enrichment into a catalog sound entry (mutates copy).
 */
export function applySfxAiEnrichment(sound, enrichment, { model = null } = {}) {
  if (!enrichment) {
    return sound;
  }

  const mergedTags = uniqueStrings([
    ...(sound.tags ?? []),
    ...enrichment.tags,
    ...getEffectiveSfxTags(sound),
  ]);

  const inferredLoudness = inferLoudnessCharacter(sound.integratedLufs);
  const next = {
    ...sound,
    description: enrichment.description,
    tags: mergedTags,
    ...(enrichment.useCases?.length ? { useCases: enrichment.useCases } : {}),
    loudnessCharacter: enrichment.loudnessCharacter
      ?? sound.loudnessCharacter
      ?? inferredLoudness
      ?? undefined,
    ...(enrichment.isLoop ? { isLoop: true } : {}),
    aiEnrichedAt: new Date().toISOString(),
  };

  if (enrichment.category && (!sound.category || sound.category === "foley")) {
    next.category = enrichment.category;
  }

  if (model) {
    next.aiEnrichModel = model;
  }

  return next;
}

export function needsSfxAiEnrichment(sound, { force = false } = {}) {
  if (force) {
    return true;
  }
  if (sound.aiEnrichedAt) {
    return false;
  }
  if (sound.description && (sound.tags ?? []).length >= 2) {
    return false;
  }
  return true;
}

/**
 * Enrich one catalog sound from disk.
 */
export async function enrichSfxCatalogSound(sound, {
  sfxDir,
  client,
  model,
  textOnly = false,
  force = false,
  systemPrompt,
  onUsage,
  prepareSampleFn = prepareSfxAudioSample,
  describeFn = describeSfxWithAi,
} = {}) {
  if (!needsSfxAiEnrichment(sound, { force })) {
    return { sound, skipped: true, reason: "already_enriched" };
  }

  const filePath = path.join(sfxDir, sound.fileName);
  if (!fs.existsSync(filePath)) {
    return { sound, skipped: true, reason: "file_missing" };
  }

  let cleanup = null;
  let samplePath = filePath;
  try {
    if (!textOnly) {
      const prepared = await prepareSampleFn(filePath);
      samplePath = prepared.samplePath;
      cleanup = prepared.cleanup;
    }

    const enrichment = await describeFn(client, {
      sound,
      audioFilePath: textOnly ? null : samplePath,
      model,
      systemPrompt,
      textOnly,
      onUsage,
    });

    if (!enrichment) {
      return { sound, skipped: true, reason: "invalid_model_response" };
    }

    const resolvedModel = model ?? resolveSfxEnrichModel({ textOnly });
    return {
      sound: applySfxAiEnrichment(sound, enrichment, { model: resolvedModel }),
      skipped: false,
      enrichment,
    };
  } finally {
    if (cleanup) {
      cleanup();
    }
  }
}
