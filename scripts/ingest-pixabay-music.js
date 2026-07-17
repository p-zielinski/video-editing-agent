#!/usr/bin/env node
/**
 * Ingest a manually downloaded Pixabay MP3 into assets/music/catalog.json.
 *
 * Usage:
 *   node scripts/ingest-pixabay-music.js
 *   node scripts/ingest-pixabay-music.js --url <pixabay-page>
 *
 * Metadane strony pobierane domyślnie przez widoczne Chromium (Playwright).
 * Jednorazowy setup: npm install && npm run setup:playwright
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import {
  analyzeLocalMusicFile,
  buildCatalogEntry,
  upsertCatalogTrack,
} from "../src/lib/ingest-music-track.js";
import {
  fetchPixabayMusicPageHtml,
} from "../src/lib/pixabay-music-fetch.js";
import {
  expectedMp3FileNameFromUrl,
  parsePixabayMusicPage,
  resolveMusicFileForPixabayUrl,
} from "../src/lib/pixabay-music-page.js";
import { enrichMusicAfterIngest } from "../src/lib/catalog-post-ingest-enrich.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MUSIC_DIR = path.join(REPO_ROOT, "assets", "music");
const CATALOG_PATH = path.join(MUSIC_DIR, "catalog.json");

function printUsage() {
  console.log(`Usage:
  node scripts/ingest-pixabay-music.js
  node scripts/ingest-pixabay-music.js --url <pixabay-page-url> [--file <mp3>]
  node scripts/ingest-pixabay-music.js --html <saved-page.html> [--file <mp3>]

Interactive: URL → auto MP3 ({slug}.mp3 lub *-{id}.mp3) → widoczne Chromium → catalog.json

Setup (raz):
  npm install && npm run setup:playwright

Options:
  --headless           Headless Chromium (szybsze, często blokowane przez Pixabay)
  --http-only          Tylko fetch HTTP (zwykle 403 na Pixabay)
  --html <path>        Lokalny zapis strony zamiast pobierania
  --tags-json <path>   Ręczne tagi JSON
  --title <text>       Nadpisz tytuł
  --track-id <id>      Nadpisz trackId
  --dry-run            Bez zapisu catalog.json
  --force              Nadpisz istniejący trackId (i wymuś ponowny AI enrich)
  --skip-enrich        Pomiń automatyczny AI enrich po ingeście
  --captcha-wait-sec <n>  Czas na captcha w widocznym Chromium (domyślnie 180s)
  --help               Pomoc

Po udanym ingeście (bez --dry-run) automatycznie uruchamia AI enrich dla nowego wpisu.
Wymaga OPENAI_API_KEY w .env. Batch re-enrich: npm run enrich:music-catalog
`);
}

function parseArgs(argv) {
  const args = {
    url: null,
    html: null,
    tagsJson: null,
    file: null,
    title: null,
    trackId: null,
    dryRun: false,
    force: false,
    skipEnrich: false,
    help: false,
    browserHeadless: false,
    httpOnly: false,
    captchaWaitSec: null,
    interactive: argv.length === 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--url":
        args.url = argv[++i];
        break;
      case "--html":
        args.html = argv[++i];
        break;
      case "--tags-json":
        args.tagsJson = argv[++i];
        break;
      case "--file":
        args.file = argv[++i];
        break;
      case "--title":
        args.title = argv[++i];
        break;
      case "--track-id":
        args.trackId = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--skip-enrich":
        args.skipEnrich = true;
        break;
      case "--headless":
        args.browserHeadless = true;
        break;
      case "--browser-headed":
        args.browserHeadless = false;
        break;
      case "--http-only":
        args.httpOnly = true;
        break;
      case "--captcha-wait-sec":
        args.captchaWaitSec = Number(argv[++i]);
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Nieznany argument: ${token}`);
    }
  }

  return args;
}

async function promptLine(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function resolveInteractiveArgs(args) {
  if (args.help) {
    return args;
  }

  if ((args.interactive || !args.url) && !args.html && !args.tagsJson) {
    if (!process.stdin.isTTY) {
      throw new Error("Brak argumentów. Uruchom interaktywnie w terminalu lub podaj --url.");
    }
    args.url = await promptLine("Pixabay URL: ");
    if (!args.url) {
      throw new Error("URL jest wymagany.");
    }
  }

  if (!args.file && args.url && !args.tagsJson) {
    const resolved = resolveMusicFileForPixabayUrl(args.url, MUSIC_DIR);
    if (resolved) {
      args.file = resolved.fileName;
      const via = resolved.match === "slug" ? "slug URL" : "sufiks Pixabay ID";
      console.log(`→ znaleziono plik (${via}): ${resolved.fileName}`);
    } else if (process.stdin.isTTY) {
      const expected = expectedMp3FileNameFromUrl(args.url) ?? "utwor.mp3";
      const answer = await promptLine(
        `Brak ${expected} w assets/music/. Podaj nazwę MP3: `,
      );
      if (!answer) {
        throw new Error("Nazwa pliku MP3 jest wymagana.");
      }
      args.file = answer;
    }
  }

  if (!args.file && !args.tagsJson) {
    if (args.html && process.stdin.isTTY) {
      const answer = await promptLine("Nazwa pliku MP3 w assets/music/: ");
      if (!answer) {
        throw new Error("Nazwa pliku MP3 jest wymagana.");
      }
      args.file = answer;
    } else if (!args.file) {
      throw new Error("Podaj --file <mp3> lub uruchom skrypt interaktywnie z URL Pixabay.");
    }
  }

  return args;
}

async function loadPageHtml(args) {
  if (args.html) {
    return { html: fs.readFileSync(path.resolve(args.html), "utf8"), source: "local_html" };
  }

  const mode = args.httpOnly ? "http" : "browser";
  const headed = !args.browserHeadless;
  console.log(
    headed
      ? "→ otwieram widoczne Chromium…"
      : `→ pobieranie strony (${mode}, headless)…`,
  );

  try {
    const captchaWaitMs = args.captchaWaitSec != null && Number.isFinite(args.captchaWaitSec)
      ? Math.max(60, args.captchaWaitSec) * 1000
      : undefined;
    return await fetchPixabayMusicPageHtml(args.url, {
      mode,
      headed,
      captchaWaitMs,
    });
  } catch (error) {
    if (process.stdin.isTTY && !args.html && error.code === "PIXABAY_BLOCKED") {
      console.log(`\n⚠ ${error.message}`);
      const htmlPath = await promptLine(
        "Opcjonalnie podaj ścieżkę do zapisanego HTML (Enter = przerwij): ",
      );
      if (htmlPath) {
        return { html: fs.readFileSync(path.resolve(htmlPath), "utf8"), source: "local_html" };
      }
    }

    throw error;
  }
}

async function resolvePageMetadata(args) {
  if (args.tagsJson) {
    const tagsPath = path.resolve(args.tagsJson);
    const pixabay = JSON.parse(fs.readFileSync(tagsPath, "utf8"));
    return {
      pixabayId: null,
      title: args.title ?? path.basename(tagsPath, ".json"),
      pixabay,
      sourceUrl: args.url ?? null,
    };
  }

  if (!args.html && !args.url) {
    throw new Error("Podaj --url, --html albo --tags-json.");
  }

  const { html, source } = args.html
    ? { html: fs.readFileSync(path.resolve(args.html), "utf8"), source: "local_html" }
    : await loadPageHtml(args);

  console.log(`  źródło HTML: ${source}`);
  return parsePixabayMusicPage(html, { url: args.url ?? "", title: args.title });
}

async function main() {
  const args = await resolveInteractiveArgs(parseArgs(process.argv.slice(2)));
  if (args.help) {
    printUsage();
    return;
  }

  const fileName = path.basename(args.file);
  const filePath = path.isAbsolute(args.file)
    ? args.file
    : path.join(MUSIC_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Brak pliku MP3: ${filePath}. Pobierz go ręcznie do assets/music/.`);
  }

  console.log(`→ metadane Pixabay…`);
  const parsedPage = await resolvePageMetadata(args);
  console.log(`  tytuł: ${parsedPage.title}`);
  if (parsedPage.pixabayId) {
    console.log(`  pixabayId: ${parsedPage.pixabayId}`);
  }
  for (const bucket of ["genre", "mood", "movement", "theme"]) {
    const tags = parsedPage.pixabay?.[bucket];
    if (tags?.length) {
      console.log(`  ${bucket}: ${tags.join(", ")}`);
    }
  }

  console.log(`→ analiza audio: ${fileName}`);
  const analysis = await analyzeLocalMusicFile(filePath);
  console.log(`  durationSec: ${analysis.durationSec}`);
  if (analysis.bpm != null) {
    console.log(`  bpm: ${analysis.bpm}`);
  }
  if (analysis.integratedLufs != null) {
    console.log(`  integratedLufs: ${analysis.integratedLufs}`);
  }
  if (analysis.beatGrid?.beatsSec?.length) {
    console.log(`  beatGrid: ${analysis.beatGrid.beatsSec.length} beats (${analysis.beatGrid.source})`);
  }

  const entry = buildCatalogEntry({
    fileName,
    parsedPage,
    analysis,
    trackId: args.trackId,
    title: args.title,
  });

  if (args.dryRun) {
    console.log("\n[dry-run] Wpis do catalog.json:\n");
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  upsertCatalogTrack(CATALOG_PATH, entry, { force: args.force });
  console.log(`\n✓ Dopisano ${entry.trackId} do ${path.relative(REPO_ROOT, CATALOG_PATH)}`);

  if (!args.skipEnrich) {
    console.log(`\n→ AI enrich: ${entry.trackId}`);
    const enrichResult = await enrichMusicAfterIngest({
      trackId: entry.trackId,
      catalogPath: CATALOG_PATH,
      force: args.force,
      onUsage: ({ model, usage }) => {
        const tokens = usage?.total_tokens ?? "?";
        console.log(`  [${entry.trackId}] ${model} tokens=${tokens}`);
      },
    });

    if (enrichResult.skipped) {
      console.log(`  skip: ${enrichResult.reason}`);
    } else {
      console.log(`  ok: ${enrichResult.description}`);
    }
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exitCode = 1;
});
