import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact } from "../artifact-deps.js";

function resolveSourcePath(clip, manifest) {
  if (clip.sourcePath) {
    return clip.sourcePath;
  }
  const manifestClip = (manifest?.clips ?? []).find((c) => c.clipId === clip.clipId);
  return manifestClip?.sourcePath ?? null;
}

function buildStubPayload(clipId) {
  return {
    version: "1.0",
    clipId,
    indexingStatus: "stub",
    chapters: [],
    moments: [],
  };
}

async function runTwelveLabsLive({ clip, sourcePath, apiKey }) {
  // TODO: upload sourcePath to TwelveLabs, poll indexing, fetch chapters/moments/summary
  void clip;
  void sourcePath;
  void apiKey;
  throw new Error("TwelveLabs live API not implemented yet");
}

export async function runTwelveLabsStep({
  workDir,
  stub = true,
  force = false,
  apiKey,
}) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  const manifest = manifestPath && fs.existsSync(manifestPath)
    ? readJson(manifestPath)
    : null;

  const resolvedKey = apiKey ?? process.env.TWELVELABS_API_KEY;
  const useStub = stub || !resolvedKey;
  const results = [];

  for (const clip of catalog.clips) {
    const outPath = path.join(workDir, ARTIFACTS.twelvelabs(clip.clipId));
    if (force) {
      removeClipArtifact(outPath);
    }
    if (shouldUseCachedClipArtifact(workDir, outPath, force)) {
      results.push(readJson(outPath));
      continue;
    }

    let payload;
    if (useStub) {
      payload = buildStubPayload(clip.clipId);
    } else {
      const sourcePath = resolveSourcePath(clip, manifest);
      try {
        const liveResult = await runTwelveLabsLive({
          clip,
          sourcePath,
          apiKey: resolvedKey,
        });
        payload = {
          version: "1.0",
          clipId: clip.clipId,
          twelveLabsAssetId: liveResult.twelveLabsAssetId,
          indexingStatus: liveResult.indexingStatus ?? "indexed",
          chapters: liveResult.chapters ?? [],
          moments: liveResult.moments ?? [],
          ...(liveResult.clipSummary ? { clipSummary: liveResult.clipSummary } : {}),
        };
      } catch (err) {
        console.warn(
          `TwelveLabs live API unavailable for ${clip.clipId}, falling back to stub: ${err.message}`,
        );
        payload = buildStubPayload(clip.clipId);
      }
    }

    writeJson(outPath, payload);
    results.push(payload);
  }

  return results;
}
