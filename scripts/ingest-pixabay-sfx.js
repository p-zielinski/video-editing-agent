#!/usr/bin/env node
/**
 * Ingest a manually downloaded Pixabay sound effect into assets/sfx/catalog.json.
 *
 * Usage:
 *   node scripts/ingest-pixabay-sfx.js
 *   node scripts/ingest-pixabay-sfx.js --url <pixabay-sfx-page>
 *
 * Metadane pobierane domyślnie przez widoczne Chromium (Playwright).
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import {
  analyzeLocalSfxFile,
  buildSfxCatalogEntry,
  upsertSfxCatalogSound,
} from "../src/lib/ingest-sfx-track.js";
import { fetchPixabaySfxPageHtml } from "../src/lib/pixabay-music-fetch.js";
import {
  deriveEditorialTags,
  deriveSfxCategory,
  expectedAudioFileNamesFromUrl,
  parsePixabaySfxPage,
  resolveSfxFileForPixabayUrl,
} from "../src/lib/pixabay-sfx-page.js";
import { extractPixabayIdFromUrl } from "../src/lib/pixabay-music-page.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SFX_DIR = path.join(REPO_ROOT, "assets", "sfx");
const CATALOG_PATH = path.join(SFX_DIR, "catalog.json");
const LICENSES_PATH = path.join(SFX_DIR, "LICENSES.md");

function printUsage() {
  console.log(`Usage:
  node scripts/ingest-pixabay-sfx.js
  node scripts/ingest-pixabay-sfx.js --url <pixabay-sound-effects-url> [--file <audio>]
  node scripts/ingest-pixabay-sfx.js --html <saved-page.html> [--file <audio>]

Interactive: URL → auto plik ({slug}.wav/.mp3 lub *-{id}.*) → widoczne Chromium → catalog.json

Setup (raz):
  npm install && npm run setup:playwright

Options:
  --headless           Headless Chromium
  --http-only          Tylko fetch HTTP (zwykle 403)
  --html <path>        Lokalny HTML
  --tags-json <path>   Ręczne tagi: { "tags": [], "category": "..." }
  --title <text>       Nadpisz tytuł
  --sfx-id <id>        Nadpisz sfxId
  --dry-run            Bez zapisu
  --force              Nadpisz istniejący sfxId
  --captcha-wait-sec <n>  Czas na captcha w widocznym Chromium (domyślnie 180s)
  --help               Pomoc
`);
}

function parseArgs(argv) {
  const args = {
    url: null,
    html: null,
    tagsJson: null,
    file: null,
    title: null,
    sfxId: null,
    dryRun: false,
    force: false,
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
      case "--sfx-id":
        args.sfxId = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--headless":
        args.browserHeadless = true;
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

function validateSfxUrl(url) {
  if (!/\/sound-effects\//i.test(url)) {
    throw new Error("URL musi być stroną Pixabay sound-effects (np. …/sound-effects/whoosh-123/).");
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
    args.url = await promptLine("Pixabay SFX URL: ");
    if (!args.url) {
      throw new Error("URL jest wymagany.");
    }
  }

  if (args.url) {
    validateSfxUrl(args.url);
  }

  if (!args.file && args.url && !args.tagsJson) {
    const resolved = resolveSfxFileForPixabayUrl(args.url, SFX_DIR);
    if (resolved) {
      args.file = resolved.fileName;
      const via = resolved.match === "slug" ? "slug URL" : "sufiks Pixabay ID";
      console.log(`→ znaleziono plik (${via}): ${resolved.fileName}`);
    } else if (process.stdin.isTTY) {
      const expected = expectedAudioFileNamesFromUrl(args.url)[0] ?? "efekt.wav";
      const answer = await promptLine(
        `Brak ${expected} w assets/sfx/. Podaj nazwę pliku audio: `,
      );
      if (!answer) {
        throw new Error("Nazwa pliku audio jest wymagana.");
      }
      args.file = answer;
    }
  }

  if (!args.file && !args.tagsJson) {
    if (args.html && process.stdin.isTTY) {
      const answer = await promptLine("Nazwa pliku audio w assets/sfx/: ");
      if (!answer) {
        throw new Error("Nazwa pliku audio jest wymagana.");
      }
      args.file = answer;
    } else if (!args.file) {
      throw new Error("Podaj --file <audio> lub uruchom skrypt interaktywnie z URL Pixabay.");
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
    return await fetchPixabaySfxPageHtml(args.url, { mode, headed, captchaWaitMs });
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
    const manual = JSON.parse(fs.readFileSync(tagsPath, "utf8"));
    const rawTags = manual.tags ?? [];
    const title = args.title ?? path.basename(tagsPath, ".json");
    const editorialTags = deriveEditorialTags({
      title,
      rawTags,
      pixabayCategory: manual.category ?? null,
    });

    return {
      pixabayId: extractPixabayIdFromUrl(args.url ?? ""),
      title,
      rawTags,
      pixabayCategory: manual.category ?? null,
      tags: editorialTags,
      category: manual.category ?? deriveSfxCategory({
        title,
        rawTags,
        editorialTags,
        pixabayCategory: manual.category ?? null,
      }),
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
  return parsePixabaySfxPage(html, { url: args.url ?? "", title: args.title });
}

function appendLicenseRow({ fileName, sfxId, sourceUrl }) {
  if (!fs.existsSync(LICENSES_PATH)) {
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const row = `| ${fileName} | ${sfxId} | ${sourceUrl ?? ""} | pixabay-content-license | ${date} |`;
  const content = fs.readFileSync(LICENSES_PATH, "utf8");
  if (content.includes(`| ${fileName} |`)) {
    return;
  }

  fs.writeFileSync(LICENSES_PATH, `${content.trimEnd()}\n${row}\n`, "utf8");
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
    : path.join(SFX_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Brak pliku audio: ${filePath}. Pobierz go ręcznie do assets/sfx/.`);
  }

  console.log(`→ metadane Pixabay SFX…`);
  const parsedPage = await resolvePageMetadata(args);
  console.log(`  tytuł: ${parsedPage.title}`);
  if (parsedPage.pixabayId) {
    console.log(`  pixabayId: ${parsedPage.pixabayId}`);
  }
  if (parsedPage.rawTags?.length) {
    console.log(`  pixabay tags: ${parsedPage.rawTags.join(", ")}`);
  }
  console.log(`  category: ${parsedPage.category}`);
  console.log(`  editorial tags: ${(parsedPage.tags ?? []).join(", ")}`);

  console.log(`→ analiza audio: ${fileName}`);
  const analysis = await analyzeLocalSfxFile(filePath);
  console.log(`  durationSec: ${analysis.durationSec}`);
  if (analysis.integratedLufs != null) {
    console.log(`  integratedLufs: ${analysis.integratedLufs}`);
  }

  const entry = buildSfxCatalogEntry({
    fileName,
    parsedPage,
    analysis,
    sfxId: args.sfxId,
    title: args.title,
  });

  if (args.dryRun) {
    console.log("\n[dry-run] Wpis do catalog.json:\n");
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  upsertSfxCatalogSound(CATALOG_PATH, entry, { force: args.force });
  appendLicenseRow({
    fileName: entry.fileName,
    sfxId: entry.sfxId,
    sourceUrl: entry.sourceUrl ?? args.url,
  });
  console.log(`\n✓ Dopisano ${entry.sfxId} do ${path.relative(REPO_ROOT, CATALOG_PATH)}`);
  console.log("  (wiersz w LICENSES.md — jeśli nowy plik)");
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exitCode = 1;
});
