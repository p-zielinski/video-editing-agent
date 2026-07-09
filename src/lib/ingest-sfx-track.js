import fs from "node:fs";
import { probeDuration } from "./ffmpeg.js";
import { measureLoudness } from "./measure-loudness.js";
import { buildSfxId } from "./pixabay-sfx-page.js";
import { resetSfxCatalogCache } from "../editorial/sfx-library.js";

function roundSec(value) {
  return Math.round(value * 1000) / 1000;
}

function roundLufs(value) {
  return Math.round(value * 10) / 10;
}

export async function analyzeLocalSfxFile(filePath) {
  const durationSec = await probeDuration(filePath);
  const loudness = await measureLoudness(filePath).catch(() => null);

  return {
    durationSec: roundSec(durationSec),
    integratedLufs: loudness?.integratedLufs != null ? roundLufs(loudness.integratedLufs) : null,
  };
}

/**
 * @param {object} params
 */
export function buildSfxCatalogEntry({
  fileName,
  parsedPage,
  analysis,
  sfxId = null,
  title = null,
  license = "pixabay-content-license",
}) {
  const entry = {
    sfxId: sfxId ?? buildSfxId({ pixabayId: parsedPage.pixabayId, fileName }),
    fileName,
    title: title ?? parsedPage.title,
    tags: parsedPage.tags ?? [],
    category: parsedPage.category ?? "foley",
    durationSec: analysis.durationSec,
    license,
  };

  if (analysis.integratedLufs != null) {
    entry.integratedLufs = analysis.integratedLufs;
  }
  if (parsedPage.rawTags?.length) {
    entry.pixabay = {
      tags: parsedPage.rawTags,
      ...(parsedPage.pixabayCategory ? { category: parsedPage.pixabayCategory } : {}),
    };
  }
  if (parsedPage.sourceUrl) {
    entry.sourceUrl = parsedPage.sourceUrl;
  }

  return entry;
}

export function loadSfxCatalog(catalogPath) {
  if (!fs.existsSync(catalogPath)) {
    return { version: "1.0", sounds: [] };
  }
  return JSON.parse(fs.readFileSync(catalogPath, "utf8"));
}

export function upsertSfxCatalogSound(catalogPath, entry, { force = false } = {}) {
  const catalog = loadSfxCatalog(catalogPath);
  const sounds = catalog.sounds ?? [];
  const existingIndex = sounds.findIndex((sound) => sound.sfxId === entry.sfxId);

  if (existingIndex >= 0 && !force) {
    throw new Error(
      `sfxId "${entry.sfxId}" już istnieje w katalogu. Użyj --force aby nadpisać.`,
    );
  }

  if (existingIndex >= 0) {
    sounds[existingIndex] = entry;
  } else {
    sounds.push(entry);
  }

  catalog.sounds = sounds;
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  resetSfxCatalogCache();
  return catalog;
}
