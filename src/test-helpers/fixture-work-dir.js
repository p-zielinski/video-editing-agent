import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkDir } from "../pipeline/work-paths.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES_BATCHES_DIR = path.join(REPO_ROOT, "fixtures", "batches");

export function resolveFixtureBatch(batchName) {
  const batchDir = path.join(FIXTURES_BATCHES_DIR, batchName);
  if (!fs.existsSync(batchDir)) {
    throw new Error(`Fixture batch not found: ${batchName} (${batchDir})`);
  }
  return batchDir;
}

export function loadFixtureArtifact(batchName, fileName) {
  const filePath = path.join(resolveFixtureBatch(batchName), fileName);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function copyEntry(srcPath, destPath) {
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    fs.mkdirSync(destPath, { recursive: true });
    for (const entry of fs.readdirSync(srcPath)) {
      copyEntry(path.join(srcPath, entry), path.join(destPath, entry));
    }
    return;
  }
  fs.copyFileSync(srcPath, destPath);
}

/**
 * Copies a fixture batch into a fresh temp work directory.
 * @param {string} batchName - e.g. "mini-day"
 * @param {{ exclude?: string[], prefix?: string }} [options]
 * @returns {string} absolute path to the temp work directory
 */
function copyFixtureEntries(batchName, workDir, { exclude = [] } = {}) {
  const src = resolveFixtureBatch(batchName);
  fs.mkdirSync(workDir, { recursive: true });

  for (const entry of fs.readdirSync(src)) {
    if (exclude.includes(entry)) {
      continue;
    }
    copyEntry(path.join(src, entry), path.join(workDir, entry));
  }

  return workDir;
}

export function copyFixtureToWorkDir(batchName, { exclude = [], prefix = "vea-e2e" } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${batchName}-`));
  return copyFixtureEntries(batchName, workDir, { exclude });
}

/**
 * Seeds output/.work/<batchId> from a fixture batch (for runPipeline E2E).
 */
export function seedBatchWorkDirFromFixture(batchName, batchId, { exclude = [] } = {}) {
  return copyFixtureEntries(batchName, resolveWorkDir(batchId), { exclude });
}

export function cleanupWorkDir(workDir) {
  if (workDir && fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Touch a file so its mtime is newer than another file.
 */
export function touchNewerThan(filePath, referencePath, offsetMs = 5000) {
  const refMtime = fs.statSync(referencePath).mtimeMs;
  const newTime = new Date(refMtime + offsetMs);
  fs.utimesSync(filePath, newTime, newTime);
}
