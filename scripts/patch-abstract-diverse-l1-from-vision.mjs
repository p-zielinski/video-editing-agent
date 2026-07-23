#!/usr/bin/env node
/**
 * SYNTHETIC / DEV ONLY — patch batch abstract L1 from on-disk vision captions.
 *
 * Does NOT call OpenAI. Writes diverse L1 summaries derived from vision captions
 * so local director experiments can proceed without a live abstract re-run.
 *
 * Safety:
 * - Creates `06-abstract.json.bak.<timestamp>` before overwrite
 * - Marks L3 / L1 entries with synthetic provenance in summaries when possible
 * - Refuse to run unless --confirm is passed
 *
 * Usage:
 *   node scripts/patch-abstract-diverse-l1-from-vision.mjs --batch-id 51cd206d --confirm
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { confirm: false, batchId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--confirm") {
      out.confirm = true;
    } else if (arg === "--batch-id") {
      out.batchId = argv[++i];
    }
  }
  return out;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectVisionCaptions(workDir) {
  const byScene = new Map();
  for (const name of fs.readdirSync(workDir)) {
    if (!name.startsWith("03-vision-") || !name.endsWith(".json")) {
      continue;
    }
    const vision = loadJson(path.join(workDir, name));
    for (const cap of vision.captions ?? vision.frames ?? []) {
      const sceneId = cap.sceneId;
      const text = cap.caption ?? cap.text ?? cap.description;
      if (!sceneId || !text) {
        continue;
      }
      if (!byScene.has(sceneId)) {
        byScene.set(sceneId, []);
      }
      byScene.get(sceneId).push(String(text).trim());
    }
  }
  return byScene;
}

function buildL1FromTimeline(timeline, visionByScene) {
  return (timeline.scenes ?? []).map((scene, index) => {
    const captions = visionByScene.get(scene.sceneId) ?? [];
    const caption = captions[0] ?? `scene ${scene.sceneId} (no vision caption)`;
    return {
      sceneId: scene.sceneId,
      summary: `[synthetic-from-vision] ${caption}`.slice(0, 500),
      mood: index % 3 === 0 ? "spokojny" : index % 3 === 1 ? "dynamiczny" : "ciepły",
      keyMoments: caption.split(/\s+/).slice(0, 3),
      isNarrationSource: Boolean(scene.hasSpeech),
      _synthetic: true,
    };
  });
}

function buildL2FromScenes(scenes) {
  if (!scenes.length) {
    return [];
  }
  const mid = Math.ceil(scenes.length / 2);
  const chunks = [scenes.slice(0, mid), scenes.slice(mid)].filter((c) => c.length > 0);
  return chunks.map((chunk, i) => ({
    segmentId: `seg${String(i + 1).padStart(3, "0")}`,
    startSec: chunk[0].startSec ?? 0,
    endSec: chunk.at(-1).endSec ?? 0,
    sceneIds: chunk.map((s) => s.sceneId),
    summary: `[synthetic] Segment ${i + 1}: ${chunk.map((s) => s.sceneId).join(", ")}`,
  }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.batchId) {
    console.error("Usage: node scripts/patch-abstract-diverse-l1-from-vision.mjs --batch-id <id> --confirm");
    process.exit(1);
  }
  if (!args.confirm) {
    console.error("Refusing to patch without --confirm (dev synthetic overwrite).");
    process.exit(1);
  }

  const workDir = path.join(ROOT, "output", ".work", args.batchId);
  const abstractPath = path.join(workDir, "06-abstract.json");
  const timelinePath = path.join(workDir, "04-timeline-index.json");
  if (!fs.existsSync(abstractPath) || !fs.existsSync(timelinePath)) {
    console.error(`Missing abstract or timeline under ${workDir}`);
    process.exit(1);
  }

  const backup = `${abstractPath}.bak.${Date.now()}`;
  fs.copyFileSync(abstractPath, backup);

  const timeline = loadJson(timelinePath);
  const visionByScene = collectVisionCaptions(workDir);
  const L1 = buildL1FromTimeline(timeline, visionByScene);
  const L2 = buildL2FromScenes(timeline.scenes ?? []);
  const previous = loadJson(abstractPath);

  const next = {
    ...previous,
    L1,
    L2,
    L3: {
      ...(previous.L3 ?? {}),
      sessionSummary: previous.L3?.sessionSummary
        ?? "[synthetic] Session rebuilt from vision captions for brief-slim experiments",
      _syntheticNote: "L1/L2 patched by scripts/patch-abstract-diverse-l1-from-vision.mjs — not LLM",
    },
  };

  fs.writeFileSync(abstractPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    synthetic: true,
    batchId: args.batchId,
    backup,
    uniqueL1: new Set(L1.map((e) => e.sceneId)).size,
    l2Segments: L2.length,
    visionScenes: visionByScene.size,
  }, null, 2));
}

main();
