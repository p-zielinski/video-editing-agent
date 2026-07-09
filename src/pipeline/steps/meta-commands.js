import path from "node:path";
import { extractMetaCommands } from "../../editorial/meta-commands.js";
import { readJson, writeJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact } from "../artifact-deps.js";
import { getClipConcurrencyLimit, runWithConcurrency } from "../../lib/clip-concurrency.js";

export function buildMetaCommandsArtifact({ clipId, words, scenes }) {
  const clipScenes = (scenes ?? []).filter((scene) => scene.clipId === clipId);
  const commands = extractMetaCommands(words ?? [], {
    scenes: clipScenes,
    clipId,
  });

  return {
    version: "1.0",
    clipId,
    commands,
  };
}

export async function extractMetaCommandsForClip({
  workDir,
  clip,
  force = false,
  words = null,
}) {
  const outPath = path.join(workDir, ARTIFACTS.metaCommands(clip.clipId));
  if (force) {
    removeClipArtifact(outPath);
  }
  if (shouldUseCachedClipArtifact(workDir, outPath, force, {
    clipId: clip.clipId,
  })) {
    return readJson(outPath);
  }

  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const wordIndex = words
    ?? readJson(path.join(workDir, ARTIFACTS.words(clip.clipId)));

  const artifact = buildMetaCommandsArtifact({
    clipId: clip.clipId,
    words: wordIndex.words ?? [],
    scenes: catalog.scenes ?? [],
  });

  writeJson(outPath, artifact);
  return artifact;
}

export async function runMetaCommandsStep({
  workDir,
  force = false,
  wordsByClip = null,
}) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const wordsMap = new Map((wordsByClip ?? []).map((entry) => [entry.clipId, entry]));

  return runWithConcurrency(
    catalog.clips,
    (clip) => extractMetaCommandsForClip({
      workDir,
      clip,
      force,
      words: wordsMap.get(clip.clipId) ?? null,
    }),
    { limit: getClipConcurrencyLimit(), label: "meta-commands" },
  );
}
