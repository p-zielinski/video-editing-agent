import "dotenv/config";
import fs from "node:fs";
import { createOpenAIClient } from "../agents/openai-client.js";
import { resetMusicCatalogCache } from "../editorial/music-library.js";
import { resetSfxCatalogCache } from "../editorial/sfx-library.js";
import { loadCatalog } from "./ingest-music-track.js";
import { loadSfxCatalog } from "./ingest-sfx-track.js";
import {
  enrichMusicCatalogTrack,
  probeMusicEnrichTextModel,
} from "./music-ai-enrich.js";
import {
  enrichSfxCatalogSound,
  probeSfxEnrichTextModel,
  warnIfSfxEnrichModelMismatch,
} from "./sfx-ai-enrich.js";

function requireOpenAiApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Brak OPENAI_API_KEY — ustaw w .env (wymagane dla AI enrich po ingeście)");
  }
  return apiKey;
}

function saveMusicCatalog(catalogPath, catalog) {
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  resetMusicCatalogCache();
}

function saveSfxCatalog(catalogPath, catalog) {
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  resetSfxCatalogCache();
}

/**
 * AI-enrich a single music track after Pixabay ingest.
 */
export async function enrichMusicAfterIngest({
  trackId,
  catalogPath,
  force = false,
  onUsage,
  client: injectedClient,
  describeFn,
} = {}) {
  if (!trackId) {
    throw new Error("trackId jest wymagany dla post-ingest music enrich");
  }
  if (!catalogPath) {
    throw new Error("catalogPath jest wymagany dla post-ingest music enrich");
  }

  const apiKey = requireOpenAiApiKey();
  const client = injectedClient ?? createOpenAIClient(apiKey);

  const catalog = loadCatalog(catalogPath);
  const track = (catalog.tracks ?? []).find((entry) => entry.trackId === trackId);
  if (!track) {
    throw new Error(`Nie znaleziono trackId "${trackId}" w katalogu`);
  }

  if (!describeFn) {
    const textModel = await probeMusicEnrichTextModel(client);
    if (!textModel) {
      throw new Error("Brak dostępnego modelu tekstowego dla music enrich");
    }
  }

  const result = await enrichMusicCatalogTrack(track, {
    client,
    force,
    onUsage,
    describeFn,
  });

  if (result.skipped) {
    return {
      enriched: false,
      skipped: true,
      reason: result.reason,
      track: result.track,
      description: result.track?.description ?? null,
    };
  }

  catalog.tracks = (catalog.tracks ?? []).map((entry) =>
    entry.trackId === trackId ? result.track : entry,
  );
  saveMusicCatalog(catalogPath, catalog);

  return {
    enriched: true,
    skipped: false,
    reason: null,
    track: result.track,
    description: result.track.description,
  };
}

/**
 * AI-enrich a single SFX entry after Pixabay ingest.
 */
export async function enrichSfxAfterIngest({
  sfxId,
  catalogPath,
  sfxDir,
  force = false,
  textOnly = true,
  onUsage,
  client: injectedClient,
  describeFn,
  prepareSampleFn,
} = {}) {
  if (!sfxId) {
    throw new Error("sfxId jest wymagany dla post-ingest SFX enrich");
  }
  if (!catalogPath) {
    throw new Error("catalogPath jest wymagany dla post-ingest SFX enrich");
  }
  if (!sfxDir) {
    throw new Error("sfxDir jest wymagany dla post-ingest SFX enrich");
  }

  const apiKey = requireOpenAiApiKey();
  const client = injectedClient ?? createOpenAIClient(apiKey);

  if (!textOnly) {
    warnIfSfxEnrichModelMismatch();
  }

  if (!describeFn && textOnly) {
    const textModel = await probeSfxEnrichTextModel(client);
    if (!textModel) {
      throw new Error("Brak dostępnego modelu tekstowego dla SFX enrich");
    }
  }

  const catalog = loadSfxCatalog(catalogPath);
  const sound = (catalog.sounds ?? []).find((entry) => entry.sfxId === sfxId);
  if (!sound) {
    throw new Error(`Nie znaleziono sfxId "${sfxId}" w katalogu`);
  }

  const result = await enrichSfxCatalogSound(sound, {
    sfxDir,
    client,
    textOnly,
    force,
    onUsage,
    describeFn,
    prepareSampleFn,
  });

  if (result.skipped) {
    return {
      enriched: false,
      skipped: true,
      reason: result.reason,
      sound: result.sound,
      description: result.sound?.description ?? null,
    };
  }

  catalog.sounds = (catalog.sounds ?? []).map((entry) =>
    entry.sfxId === sfxId ? result.sound : entry,
  );
  saveSfxCatalog(catalogPath, catalog);

  return {
    enriched: true,
    skipped: false,
    reason: null,
    sound: result.sound,
    description: result.sound.description,
  };
}
