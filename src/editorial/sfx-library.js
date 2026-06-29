import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CATALOG_PATH = path.join(ROOT, "assets", "sfx", "catalog.json");
const DEFAULT_SFX_DIR = path.join(ROOT, "assets", "sfx");

let cachedCatalog = null;

export function resolveSfxCatalogPath(catalogPath = DEFAULT_CATALOG_PATH) {
  return catalogPath;
}

export function loadSfxCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  if (cachedCatalog && catalogPath === DEFAULT_CATALOG_PATH) {
    return cachedCatalog;
  }

  const resolved = resolveSfxCatalogPath(catalogPath);
  if (!fs.existsSync(resolved)) {
    return { version: "1.0", sounds: [] };
  }

  const catalog = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (catalogPath === DEFAULT_CATALOG_PATH) {
    cachedCatalog = catalog;
  }
  return catalog;
}

export function listSfxCatalog(catalogPath) {
  const catalog = loadSfxCatalog(catalogPath);
  return catalog.sounds ?? [];
}

export function resolveSfxFilePath(sound, catalogPath = DEFAULT_CATALOG_PATH) {
  const resolvedCatalogPath = catalogPath ?? DEFAULT_CATALOG_PATH;
  const sfxDir = resolvedCatalogPath === DEFAULT_CATALOG_PATH
    ? DEFAULT_SFX_DIR
    : path.dirname(resolveSfxCatalogPath(resolvedCatalogPath));
  return path.join(sfxDir, sound.fileName);
}

export function isSfxFileAvailable(sound, catalogPath = DEFAULT_CATALOG_PATH) {
  if (!sound?.fileName) {
    return false;
  }
  return fs.existsSync(resolveSfxFilePath(sound, catalogPath));
}

/**
 * Resolve a catalog sound by sfxId; returns null sound when the audio file is missing on disk.
 */
export function resolveSfxById(sfxId, { catalogPath = DEFAULT_CATALOG_PATH } = {}) {
  const sound = listSfxCatalog(catalogPath).find((entry) => entry.sfxId === sfxId);
  if (!sound) {
    return { sound: null, reason: "sfx_not_in_catalog" };
  }
  if (!isSfxFileAvailable(sound, catalogPath)) {
    return { sound: null, reason: "sfx_file_missing" };
  }
  return { sound, reason: null };
}

/**
 * Resolve first catalog sound matching an editorial tag.
 */
export function resolveSfxByTag(tag, { catalogPath = DEFAULT_CATALOG_PATH } = {}) {
  const normalized = String(tag).toLowerCase();
  const sound = listSfxCatalog(catalogPath).find((entry) =>
    (entry.tags ?? []).some((entryTag) => String(entryTag).toLowerCase() === normalized),
  );
  if (!sound) {
    return { sound: null, reason: "sfx_not_in_catalog" };
  }
  if (!isSfxFileAvailable(sound, catalogPath)) {
    return { sound: null, reason: "sfx_file_missing" };
  }
  return { sound, reason: null };
}

export function resetSfxCatalogCache() {
  cachedCatalog = null;
}
