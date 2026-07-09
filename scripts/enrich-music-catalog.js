#!/usr/bin/env node
/**
 * AI-enrich assets/music/catalog.json with descriptions and director use cases.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAIClient } from "../src/agents/openai-client.js";
import { loadMusicCatalog } from "../src/editorial/music-library.js";
import { resetMusicCatalogCache } from "../src/editorial/music-library.js";
import {
  enrichMusicCatalogTrack,
  needsMusicAiEnrichment,
  probeMusicEnrichTextModel,
} from "../src/lib/music-ai-enrich.js";
import { resolveSfxEnrichTextModels } from "../src/lib/sfx-ai-enrich.js";
import { mapWithConcurrency } from "../src/lib/map-with-concurrency.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MUSIC_DIR = path.join(REPO_ROOT, "assets", "music");
const CATALOG_PATH = path.join(MUSIC_DIR, "catalog.json");

function parseArgs(argv) {
  const args = {
    all: false,
    force: false,
    dryRun: false,
    concurrency: 1,
    trackIds: [],
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--all") {
      args.all = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--concurrency" && argv[i + 1]) {
      args.concurrency = Number(argv[++i]) || 1;
    } else if (arg === "--track-id" && argv[i + 1]) {
      args.trackIds.push(argv[++i]);
    }
  }

  return args;
}

function selectTracks(catalog, args) {
  const tracks = catalog.tracks ?? [];
  if (args.trackIds.length > 0) {
    return tracks.filter((track) => args.trackIds.includes(track.trackId));
  }
  if (args.all) {
    return tracks.filter((track) => needsMusicAiEnrichment(track, { force: args.force }));
  }
  return tracks.filter((track) =>
    needsMusicAiEnrichment(track, { force: args.force })
    && !track.description,
  );
}

function saveCatalog(catalog) {
  fs.writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  resetMusicCatalogCache();
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage:
  node scripts/enrich-music-catalog.js [--all] [--track-id <id>] [--force] [--dry-run]

Wymaga OPENAI_API_KEY. Domyślnie text-only (gpt-5.4-nano) z metadanych Pixabay.`);
    return;
  }

  const catalog = loadMusicCatalog(CATALOG_PATH);
  const targets = selectTracks(catalog, args);

  if (targets.length === 0) {
    console.log("Brak utworów do wzbogacenia.");
    return;
  }

  console.log(`Music AI enrich: ${targets.length} utwor(ów)`);
  console.log(`  model text chain: ${resolveSfxEnrichTextModels().join(" → ")}`);

  if (args.dryRun) {
    for (const track of targets) {
      console.log(`- ${track.trackId} | ${track.title}`);
    }
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Brak OPENAI_API_KEY — ustaw w .env");
  }

  const client = createOpenAIClient(apiKey);
  const textModel = await probeMusicEnrichTextModel(client);
  if (!textModel) {
    throw new Error("Brak dostępnego modelu tekstowego dla music enrich");
  }
  console.log(`  using text model: ${textModel}`);

  let enrichedCount = 0;
  let errorCount = 0;

  const results = await mapWithConcurrency(targets, args.concurrency, async (track) => {
    try {
      const result = await enrichMusicCatalogTrack(track, {
        client,
        force: args.force,
        onUsage: ({ model, usage }) => {
          const tokens = usage?.total_tokens ?? "?";
          console.log(`  [${track.trackId}] ${model} tokens=${tokens}`);
        },
      });

      if (result.skipped) {
        console.log(`  skip ${track.trackId}: ${result.reason}`);
        return { track, updated: false };
      }

      enrichedCount += 1;
      console.log(`  ok ${track.trackId}: ${result.track.description}`);
      return { track: result.track, updated: true };
    } catch (error) {
      errorCount += 1;
      console.error(`  err ${track.trackId}: ${error.message}`);
      return { track, updated: false, error };
    }
  });

  const byId = new Map(results.map((entry) => [entry.track.trackId, entry.track]));
  catalog.tracks = (catalog.tracks ?? []).map((track) => byId.get(track.trackId) ?? track);
  saveCatalog(catalog);

  console.log(`\nGotowe: enriched=${enrichedCount}, errors=${errorCount}`);
  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
