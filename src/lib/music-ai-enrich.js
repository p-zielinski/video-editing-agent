import { loadPrompt } from "../agents/openai-client.js";
import {
  probeSfxEnrichTextModel,
  resolveSfxEnrichTextModels,
} from "./sfx-ai-enrich.js";

const VOICE_TARGET_LUFS = -16;
const DEFAULT_BED_VOLUME_DB = -18;

export const ALLOWED_MUSIC_ENERGIES = new Set(["low", "medium", "high"]);
export const ALLOWED_GOOD_FOR = new Set(["short", "main"]);

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeTag(tag) {
  return String(tag ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeEnergy(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ALLOWED_MUSIC_ENERGIES.has(normalized) ? normalized : null;
}

export function suggestMusicBedVolumeDb(track, {
  voiceTargetLufs = VOICE_TARGET_LUFS,
  baseVolumeDb = DEFAULT_BED_VOLUME_DB,
} = {}) {
  if (!Number.isFinite(track?.integratedLufs)) {
    return baseVolumeDb;
  }
  const loudnessDelta = voiceTargetLufs - track.integratedLufs;
  return Math.round((baseVolumeDb + loudnessDelta * 0.25) * 10) / 10;
}

/**
 * @param {unknown} raw
 */
export function normalizeMusicAiEnrichment(raw) {
  const description = String(raw?.description ?? "").trim();
  if (!description) {
    return null;
  }

  const mood = uniqueStrings(
    (Array.isArray(raw?.mood) ? raw.mood : [])
      .map(normalizeTag)
      .filter(Boolean),
  ).slice(0, 10);

  const useCase = uniqueStrings(
    (Array.isArray(raw?.useCase) ? raw.useCase : [])
      .map(normalizeTag)
      .filter(Boolean),
  ).slice(0, 6);

  const goodFor = uniqueStrings(
    (Array.isArray(raw?.goodFor) ? raw.goodFor : [])
      .map((entry) => String(entry ?? "").trim().toLowerCase())
      .filter((entry) => ALLOWED_GOOD_FOR.has(entry)),
  );

  const directorUseCases = uniqueStrings(
    (Array.isArray(raw?.directorUseCases) ? raw.directorUseCases : [])
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean),
  ).slice(0, 4);

  const energy = normalizeEnergy(raw?.energy);
  const hasVocals = raw?.hasVocals === true;
  const suggestedBedVolumeDb = Number.isFinite(raw?.suggestedBedVolumeDb)
    ? Math.round(raw.suggestedBedVolumeDb * 10) / 10
    : null;

  return {
    description,
    ...(mood.length ? { mood } : {}),
    ...(useCase.length ? { useCase } : {}),
    ...(goodFor.length ? { goodFor } : {}),
    ...(energy ? { energy } : {}),
    hasVocals,
    ...(directorUseCases.length ? { directorUseCases } : {}),
    ...(suggestedBedVolumeDb != null ? { suggestedBedVolumeDb } : {}),
  };
}

export function buildMusicEnrichUserText(track) {
  const pixabay = track.pixabay ?? {};
  const lines = [
    `trackId: ${track.trackId}`,
    `title: ${track.title ?? track.trackId}`,
    `fileName: ${track.fileName}`,
    `durationSec: ${track.durationSec ?? "?"}`,
    `bpm: ${track.bpm ?? "?"}`,
    `energy: ${track.energy ?? "?"}`,
    `integratedLufs: ${track.integratedLufs ?? "?"}`,
    `currentMood: ${(track.mood ?? []).join(", ") || "(brak)"}`,
    `currentUseCase: ${(track.useCase ?? []).join(", ") || "(brak)"}`,
    `genre: ${(pixabay.genre ?? []).join(", ") || "(brak)"}`,
    `moodTags: ${(pixabay.mood ?? []).join(", ") || "(brak)"}`,
    `movement: ${(pixabay.movement ?? []).join(", ") || "(brak)"}`,
    `theme: ${(pixabay.theme ?? []).join(", ") || "(brak)"}`,
  ];
  if (track.sourceUrl) {
    lines.push(`sourceUrl: ${track.sourceUrl}`);
  }
  return lines.join("\n");
}

async function callMusicEnrichOnce(client, { track, model, systemPrompt, onUsage }) {
  const system = systemPrompt ?? loadPrompt("music-enricher", { version: "v1" });
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: buildMusicEnrichUserText(track) },
    ],
  });

  if (typeof onUsage === "function" && response.usage) {
    onUsage({ model, usage: response.usage });
  }

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Pusta odpowiedź modelu music enricher");
  }

  return normalizeMusicAiEnrichment(JSON.parse(content));
}

function isModelUnavailableError(error) {
  const message = String(error?.message ?? error ?? "");
  const status = error?.status ?? error?.statusCode;
  return status === 404
    || /does not exist or you do not have access/i.test(message)
    || /premature close/i.test(message);
}

export async function describeMusicWithAi(client, {
  track,
  model,
  systemPrompt,
  onUsage,
} = {}) {
  const models = model ? [model, ...resolveSfxEnrichTextModels()] : resolveSfxEnrichTextModels();
  const uniqueModels = [...new Set(models)];

  let lastError = null;
  for (const candidate of uniqueModels) {
    try {
      return await callMusicEnrichOnce(client, {
        track,
        model: candidate,
        systemPrompt,
        onUsage,
      });
    } catch (error) {
      lastError = error;
      if (!isModelUnavailableError(error)) {
        throw error;
      }
      console.warn(`[music-enrich] model ${candidate} niedostępny — ${error.message}`);
    }
  }

  throw lastError ?? new Error("Brak dostępnego modelu music enricher");
}

export function applyMusicAiEnrichment(track, enrichment, { model = null } = {}) {
  if (!enrichment) {
    return track;
  }

  const suggestedBedVolumeDb = enrichment.suggestedBedVolumeDb
    ?? suggestMusicBedVolumeDb(track);

  const next = {
    ...track,
    description: enrichment.description,
    ...(enrichment.mood?.length ? { mood: enrichment.mood } : {}),
    ...(enrichment.useCase?.length ? { useCase: enrichment.useCase } : {}),
    ...(enrichment.goodFor?.length ? { goodFor: enrichment.goodFor } : {}),
    ...(enrichment.energy ? { energy: enrichment.energy } : {}),
    hasVocals: enrichment.hasVocals === true,
    ...(enrichment.directorUseCases?.length
      ? { directorUseCases: enrichment.directorUseCases }
      : {}),
    suggestedBedVolumeDb,
    aiEnrichedAt: new Date().toISOString(),
  };

  if (model) {
    next.aiEnrichModel = model;
  }

  return next;
}

export function needsMusicAiEnrichment(track, { force = false } = {}) {
  if (force) {
    return true;
  }
  if (track.aiEnrichedAt) {
    return false;
  }
  if (track.description && (track.directorUseCases?.length ?? 0) > 0) {
    return false;
  }
  return true;
}

export async function enrichMusicCatalogTrack(track, {
  client,
  model,
  force = false,
  systemPrompt,
  onUsage,
  describeFn = describeMusicWithAi,
} = {}) {
  if (!needsMusicAiEnrichment(track, { force })) {
    return { track, skipped: true, reason: "already_enriched" };
  }

  const enrichment = await describeFn(client, {
    track,
    model,
    systemPrompt,
    onUsage,
  });

  if (!enrichment) {
    return { track, skipped: true, reason: "invalid_model_response" };
  }

  const resolvedModel = model ?? resolveSfxEnrichTextModels()[0];
  return {
    track: applyMusicAiEnrichment(track, enrichment, { model: resolvedModel }),
    skipped: false,
    enrichment,
  };
}

export { probeSfxEnrichTextModel as probeMusicEnrichTextModel };
