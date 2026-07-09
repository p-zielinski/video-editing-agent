#!/usr/bin/env node
/**
 * AI-enrich assets/sfx/catalog.json with descriptions, tags, and use cases.
 *
 * Usage:
 *   node scripts/enrich-sfx-catalog.js
 *   node scripts/enrich-sfx-catalog.js --all
 *   node scripts/enrich-sfx-catalog.js --sfx-id pixabay_sfx_88052 --force
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAIClient } from "../src/agents/openai-client.js";
import { loadSfxCatalog } from "../src/lib/ingest-sfx-track.js";
import { enrichSfxCatalogSound, needsSfxAiEnrichment, probeSfxEnrichTextModel, resolveSfxEnrichModel, resolveSfxEnrichTextModels, warnIfSfxEnrichModelMismatch } from "../src/lib/sfx-ai-enrich.js";
import { mapWithConcurrency } from "../src/lib/map-with-concurrency.js";
import { resetSfxCatalogCache } from "../src/editorial/sfx-library.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SFX_DIR = path.join(REPO_ROOT, "assets", "sfx");
const CATALOG_PATH = path.join(SFX_DIR, "catalog.json");

function printUsage() {
  console.log(`Usage:
  node scripts/enrich-sfx-catalog.js [--all] [--sfx-id <id>] [--force] [--dry-run]
                                     [--with-audio] [--text-only] [--concurrency <n>]

Wymaga OPENAI_API_KEY. Domyślnie: text-only (gpt-5.4-nano) z metadanych Pixabay.

Opcje:
  --all            Wzbogać wszystkie wpisy bez aiEnrichedAt (domyślnie: tylko ubogie)
  --sfx-id <id>    Jeden wpis
  --force          Nadpisz istniejące opisy AI
  --dry-run        Pokaż plan bez zapisu i bez API
  --with-audio     Odsłuch pliku (wymaga modelu *-audio-preview na koncie OpenAI)
  --text-only      Tylko metadane (domyślne)
  --concurrency N  Równoległe wywołania (domyślnie 1)
`);
}

function parseArgs(argv) {
  const args = {
    all: false,
    force: false,
    dryRun: false,
    textOnly: true,
    withAudio: false,
    concurrency: 1,
    sfxIds: [],
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
    } else if (arg === "--text-only") {
      args.textOnly = true;
      args.withAudio = false;
    } else if (arg === "--with-audio") {
      args.withAudio = true;
      args.textOnly = false;
    } else if (arg === "--concurrency" && argv[i + 1]) {
      args.concurrency = Number(argv[++i]) || 1;
    } else if (arg === "--sfx-id" && argv[i + 1]) {
      args.sfxIds.push(argv[++i]);
    }
  }

  return args;
}

function selectSounds(catalog, args) {
  const sounds = catalog.sounds ?? [];
  if (args.sfxIds.length > 0) {
    return sounds.filter((sound) => args.sfxIds.includes(sound.sfxId));
  }
  if (args.all) {
    return sounds.filter((sound) => needsSfxAiEnrichment(sound, { force: args.force }));
  }
  return sounds.filter((sound) =>
    needsSfxAiEnrichment(sound, { force: args.force })
    && ((sound.tags ?? []).length < 2 || !sound.description),
  );
}

function saveCatalog(catalog) {
  fs.writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  resetSfxCatalogCache();
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  const catalog = loadSfxCatalog(CATALOG_PATH);
  const targets = selectSounds(catalog, args);

  if (targets.length === 0) {
    console.log("Brak wpisów do wzbogacenia.");
    return;
  }

  console.log(`SFX AI enrich: ${targets.length} wpis(ów)${args.textOnly ? " (text-only)" : " (with-audio)"}`);
  if (args.withAudio) {
    warnIfSfxEnrichModelMismatch();
    console.log(`  model audio: ${resolveSfxEnrichModel({ textOnly: false })}`);
  }
  console.log(`  model text chain: ${resolveSfxEnrichTextModels().join(" → ")}`);

  if (args.dryRun) {
    for (const sound of targets) {
      console.log(`- ${sound.sfxId} | ${sound.title} | tags=${(sound.tags ?? []).join(",") || "(brak)"}`);
    }
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Brak OPENAI_API_KEY — ustaw w .env");
  }

  const client = createOpenAIClient(apiKey);

  if (args.textOnly) {
    const textModel = await probeSfxEnrichTextModel(client);
    if (!textModel) {
      throw new Error("Brak dostępnego modelu tekstowego dla SFX enrich");
    }
    console.log(`  using text model: ${textModel}`);
  }

  let enrichedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  const results = await mapWithConcurrency(targets, args.concurrency, async (sound) => {
    try {
      const result = await enrichSfxCatalogSound(sound, {
        sfxDir: SFX_DIR,
        client,
        textOnly: args.textOnly,
        force: args.force,
        onUsage: ({ model, usage }) => {
          const tokens = usage?.total_tokens ?? "?";
          console.log(`  [${sound.sfxId}] ${model} tokens=${tokens}`);
        },
      });

      if (result.skipped) {
        skippedCount += 1;
        console.log(`  skip ${sound.sfxId}: ${result.reason}`);
        return { sound, updated: false };
      }

      enrichedCount += 1;
      console.log(`  ok ${sound.sfxId}: ${result.sound.description}`);
      return { sound: result.sound, updated: true };
    } catch (error) {
      errorCount += 1;
      console.error(`  err ${sound.sfxId}: ${error.message}`);
      return { sound, updated: false, error };
    }
  });

  const byId = new Map(results.map((entry) => [entry.sound.sfxId, entry.sound]));
  catalog.sounds = (catalog.sounds ?? []).map((sound) => byId.get(sound.sfxId) ?? sound);
  saveCatalog(catalog);

  console.log(`\nGotowe: enriched=${enrichedCount}, skipped=${skippedCount}, errors=${errorCount}`);
  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
