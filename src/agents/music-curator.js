import { resolveTrackById } from "../editorial/music-library.js";
import {
  buildMusicCuratorContext,
  buildMusicCuratorShortlist,
  enrichMusicSelectionFromCatalog,
  pickTrackDeterministic,
} from "../editorial/music-catalog-filter.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";

const MUSIC_SELECTION_OUTPUT_SCHEMA = {
  trackId: "string — musi być z candidates[].trackId",
  reason: "string — 1-2 zdania po polsku",
  confidence: "number 0-1",
};

function shouldSkipMusicCurator(batchContext = {}) {
  if (batchContext.musicBed === false || /no\s*music/i.test(String(batchContext.notes ?? ""))) {
    return true;
  }
  return false;
}

function buildUserOverrideSelection(trackId, { catalogPath } = {}) {
  const { track, reason } = resolveTrackById(trackId, { catalogPath });
  if (!track) {
    return null;
  }
  return {
    trackId: track.trackId,
    title: track.title ?? track.trackId,
    reason: "Użytkownik wskazał musicBedTrackId w batchContext",
    confidence: 1,
    source: "user_override",
    skipReason: reason,
  };
}

function validateLlmSelection(raw, candidates) {
  const trackId = raw?.trackId;
  if (!trackId || typeof trackId !== "string") {
    return null;
  }
  const allowed = new Set((candidates ?? []).map((entry) => entry.trackId));
  if (!allowed.has(trackId)) {
    return null;
  }
  return {
    trackId,
    title: candidates.find((entry) => entry.trackId === trackId)?.title ?? trackId,
    reason: String(raw.reason ?? "Wybrany przez music curator"),
    confidence: Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0.7,
    source: "llm",
  };
}

/**
 * @param {object} params
 */
export function buildMusicCuratorPayload({
  abstraction,
  audioIndex,
  batchContext = {},
  requiredFormats = [],
  userContext = "",
  catalogPath,
} = {}) {
  const context = buildMusicCuratorContext({
    abstraction,
    audioIndex,
    batchContext,
    requiredFormats,
    userContext,
  });
  const candidates = buildMusicCuratorShortlist(context, { catalogPath });
  return { context, candidates };
}

/**
 * Select music bed track for director — LLM on shortlist with deterministic fallback.
 */
export async function runMusicCurator(client, {
  abstraction,
  audioIndex = null,
  batchContext = {},
  requiredFormats = [],
  userContext = "",
  catalogPath,
  onUsage,
} = {}) {
  if (shouldSkipMusicCurator(batchContext)) {
    return {
      musicSelection: null,
      skipped: true,
      skipReason: "music_bed_disabled",
    };
  }

  if (batchContext.musicBedTrackId) {
    const override = buildUserOverrideSelection(batchContext.musicBedTrackId, { catalogPath });
    return {
      musicSelection: enrichMusicSelectionFromCatalog(override, { catalogPath }),
      skipped: false,
      candidates: override ? [{ trackId: override.trackId, title: override.title }] : [],
      context: null,
    };
  }

  const { context, candidates } = buildMusicCuratorPayload({
    abstraction,
    audioIndex,
    batchContext,
    requiredFormats,
    userContext,
    catalogPath,
  });

  if (!candidates.length) {
    return {
      musicSelection: null,
      skipped: true,
      skipReason: "no_available_tracks",
      candidates,
      context,
    };
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    return {
      musicSelection: enrichMusicSelectionFromCatalog({
        trackId: only.trackId,
        title: only.title ?? only.trackId,
        reason: "Jedyny dostępny utwór w katalogu",
        confidence: 0.6,
        source: "deterministic",
      }, { catalogPath }),
      skipped: false,
      candidates,
      context,
    };
  }

  const fallback = pickTrackDeterministic(context, candidates, { catalogPath });

  if (!client) {
    return {
      musicSelection: enrichMusicSelectionFromCatalog(fallback, { catalogPath }),
      skipped: false,
      candidates,
      context,
      usedFallback: true,
    };
  }

  try {
    const system = loadPrompt("music-curator", { version: "v2" });
    const user = JSON.stringify({
      task: "select_music_bed",
      context,
      candidates,
      outputSchema: MUSIC_SELECTION_OUTPUT_SCHEMA,
    });

    const raw = await chatJson(client, {
      model: MODELS.musicCurator,
      system,
      user,
      temperature: 0.2,
      onUsage,
    });

    const validated = validateLlmSelection(raw, candidates);
    if (validated) {
      return {
        musicSelection: enrichMusicSelectionFromCatalog(validated, { catalogPath }),
        skipped: false,
        candidates,
        context,
        usedFallback: false,
      };
    }
  } catch {
    // fall through to deterministic pick
  }

  return {
    musicSelection: enrichMusicSelectionFromCatalog(fallback, { catalogPath }),
    skipped: false,
    candidates,
    context,
    usedFallback: true,
  };
}
