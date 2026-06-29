import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TECHNIQUES_DIR = path.join(ROOT, "techniques");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadMeta() {
  return readJson(path.join(TECHNIQUES_DIR, "catalog.meta.json"));
}

function loadTechniqueFile(relativePath) {
  return readJson(path.join(TECHNIQUES_DIR, relativePath));
}

function loadPack(packId) {
  const packPath = path.join(TECHNIQUES_DIR, "packs", `${packId}.json`);
  if (!fs.existsSync(packPath)) {
    return null;
  }
  return readJson(packPath);
}

function applyPackOverrides(technique, pack) {
  if (!pack?.paramOverrides?.[technique.id]) {
    return technique;
  }
  const overrides = pack.paramOverrides[technique.id];
  const params = { ...technique.params };
  for (const [key, override] of Object.entries(overrides)) {
    params[key] = { ...params[key], ...override };
  }
  return { ...technique, params };
}

function applyPackConstraintOverrides(technique, pack) {
  if (!pack?.constraintOverrides?.[technique.id]) {
    return technique;
  }
  return {
    ...technique,
    constraints: {
      ...technique.constraints,
      ...pack.constraintOverrides[technique.id],
    },
  };
}

function matchesPlatforms(technique, platforms) {
  if (!platforms?.length) {
    return true;
  }
  return technique.platforms.some((p) => platforms.includes(p));
}

/**
 * @param {{ pack?: string, platforms?: string[], techniquesDir?: string }} options
 */
export function loadTechniqueCatalog({
  pack,
  platforms,
  techniquesDir = TECHNIQUES_DIR,
} = {}) {
  const metaPath = path.join(techniquesDir, "catalog.meta.json");
  const meta = fs.existsSync(metaPath) ? readJson(metaPath) : loadMeta();
  const packId = pack ?? meta.defaultPack;
  let packDef = loadPack(packId);

  if (!packDef && packId !== meta.defaultPack) {
    packDef = loadPack(meta.defaultPack);
  }

  const effectivePackId = packDef?.id ?? meta.defaultPack;
  const enabledIds = packDef?.enabledTechniqueIds
    ? new Set(packDef.enabledTechniqueIds)
    : null;

  const techniques = [];
  for (const relativePath of meta.techniqueFiles) {
    const filePath = path.join(techniquesDir, relativePath);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    let technique = readJson(filePath);
    if (enabledIds && !enabledIds.has(technique.id)) {
      continue;
    }
    if (!matchesPlatforms(technique, platforms)) {
      continue;
    }
    technique = applyPackOverrides(technique, packDef);
    technique = applyPackConstraintOverrides(technique, packDef);
    techniques.push(technique);
  }

  const byId = new Map(techniques.map((t) => [t.id, t]));

  return {
    version: meta.version,
    packId: effectivePackId,
    pack: packDef,
    techniques,
    byId,
  };
}

export function getTechnique(catalog, techniqueId) {
  return catalog.byId.get(techniqueId) ?? null;
}

export { TECHNIQUES_DIR };
