import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  remapSceneId,
  canonicalizeClipArtifact,
  adaptClipArtifactFromCache,
} from "./global-artifact-adapt.js";

describe("global-artifact-adapt", () => {
  it("remapSceneId swaps clip prefix", () => {
    assert.equal(remapSceneId("clip01_scene002", "clip03", "clip01"), "clip03_scene002");
    assert.equal(remapSceneId("other_scene001", "clip03", "clip01"), "other_scene001");
  });

  it("canonicalize/adapt round-trip for words strips and reassigns wordIds", () => {
    const artifact = {
      version: "1.0",
      clipId: "clip01",
      sourceContentHash: "hash-a",
      durationSec: 12.5,
      words: [
        {
          wordId: "clip01_w00000",
          word: "cześć",
          start: 0.1,
          end: 0.4,
          isFiller: false,
          confidence: 0.9,
        },
      ],
    };

    const canonical = canonicalizeClipArtifact("words", artifact);
    assert.equal(canonical.clipId, undefined);
    assert.equal(canonical.sourceContentHash, undefined);
    assert.deepEqual(canonical.words, [
      { word: "cześć", start: 0.1, end: 0.4, isFiller: false, confidence: 0.9 },
    ]);

    const adapted = adaptClipArtifactFromCache("words", canonical, "clip02", "clip01");
    assert.equal(adapted.clipId, "clip02");
    assert.equal(adapted.words[0].wordId, "clip02_w00000");
    assert.equal(adapted.words[0].word, "cześć");
  });

  it("canonicalize/adapt remaps sceneIds for keyframes, vision, objects, and faces", () => {
    const keyframes = {
      version: "1.0",
      clipId: "clip01",
      sourceContentHash: "hash-kf",
      keyframes: [
        {
          timestampSec: 1,
          sceneId: "clip01_scene001",
          trigger: "speech",
          imagePath: "frames/clip01/frame-0000.jpg",
        },
      ],
    };

    const canonicalKeyframes = canonicalizeClipArtifact("keyframes", keyframes);
    assert.deepEqual(canonicalKeyframes.keyframes, [
      { timestampSec: 1, sceneId: "scene001", trigger: "speech" },
    ]);

    const adaptedKeyframes = adaptClipArtifactFromCache(
      "keyframes",
      canonicalKeyframes,
      "clip05",
      "clip01",
    );
    assert.equal(adaptedKeyframes.keyframes[0].sceneId, "clip05_scene001");
    assert.equal(adaptedKeyframes.keyframes[0].imagePath, undefined);

    const vision = {
      version: "1.0",
      clipId: "clip01",
      captions: [{ sceneId: "clip01_scene002", caption: "kitchen", timestampSec: 2 }],
    };
    const canonicalVision = canonicalizeClipArtifact("vision", vision);
    const adaptedVision = adaptClipArtifactFromCache(
      "vision",
      canonicalVision,
      "clip05",
      "clip01",
    );
    assert.equal(adaptedVision.captions[0].sceneId, "clip05_scene002");

    const objects = {
      version: "1.0",
      clipId: "clip01",
      detections: [{ sceneId: "clip01_scene001", label: "plate", confidence: 0.8 }],
    };
    const adaptedObjects = adaptClipArtifactFromCache(
      "objects",
      canonicalizeClipArtifact("objects", objects),
      "clip05",
      "clip01",
    );
    assert.equal(adaptedObjects.detections[0].sceneId, "clip05_scene001");

    const faces = {
      version: "1.0",
      clipId: "clip01",
      detections: [{ sceneId: "clip01_scene001", type: "face", confidence: 0.5 }],
    };
    const adaptedFaces = adaptClipArtifactFromCache(
      "faces",
      canonicalizeClipArtifact("faces", faces),
      "clip05",
      "clip01",
    );
    assert.equal(adaptedFaces.detections[0].sceneId, "clip05_scene001");
  });

  it("canonicalize/adapt preserves content for audioAnalysis and twelvelabs", () => {
    const audio = {
      version: "1.0",
      clipId: "clip01",
      sourceContentHash: "hash-audio",
      voiceLufs: -16,
      beats: [{ timeSec: 1, strength: 0.8 }],
    };
    const canonicalAudio = canonicalizeClipArtifact("audioAnalysis", audio);
    assert.equal(canonicalAudio.clipId, undefined);
    const adaptedAudio = adaptClipArtifactFromCache(
      "audioAnalysis",
      canonicalAudio,
      "clip09",
      "clip01",
    );
    assert.equal(adaptedAudio.clipId, "clip09");
    assert.equal(adaptedAudio.voiceLufs, -16);

    const twelvelabs = {
      version: "1.1",
      clipId: "clip01",
      indexingStatus: "indexed",
      twelveLabsAssetId: "asset-123",
      moments: [{ startSec: 2, endSec: 8, description: "chef plating" }],
    };
    const adaptedTwelveLabs = adaptClipArtifactFromCache(
      "twelvelabs",
      canonicalizeClipArtifact("twelvelabs", twelvelabs),
      "clip09",
      "clip01",
    );
    assert.equal(adaptedTwelveLabs.clipId, "clip09");
    assert.equal(adaptedTwelveLabs.twelveLabsAssetId, "asset-123");
    assert.equal(adaptedTwelveLabs.moments[0].description, "chef plating");
  });
});
