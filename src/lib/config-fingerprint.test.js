import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildStepConfigFingerprint } from "./config-fingerprint.js";
import { EXPECTED_ARTIFACT_VERSIONS } from "./clip-artifact-cache.js";

describe("config-fingerprint", () => {
  let previousIndexId;
  let previousWhisperModel;

  before(() => {
    previousIndexId = process.env.TWELVELABS_INDEX_ID;
    previousWhisperModel = process.env.OPENAI_WHISPER_MODEL;
    process.env.TWELVELABS_INDEX_ID = "index-test-123";
    delete process.env.OPENAI_WHISPER_MODEL;
  });

  after(() => {
    if (previousIndexId === undefined) {
      delete process.env.TWELVELABS_INDEX_ID;
    } else {
      process.env.TWELVELABS_INDEX_ID = previousIndexId;
    }
    if (previousWhisperModel === undefined) {
      delete process.env.OPENAI_WHISPER_MODEL;
    } else {
      process.env.OPENAI_WHISPER_MODEL = previousWhisperModel;
    }
  });

  it("returns stable fingerprints per step", () => {
    const wordsA = buildStepConfigFingerprint("words");
    const wordsB = buildStepConfigFingerprint("words");
    assert.equal(wordsA, wordsB);
    assert.match(wordsA, /^[a-f0-9]{16}$/);
  });

  it("includes artifact version and step-specific flags", () => {
    const visionStub = buildStepConfigFingerprint("vision", { stub: true });
    const visionLive = buildStepConfigFingerprint("vision", { stub: false });
    assert.notEqual(visionStub, visionLive);

    const objectsDisabled = buildStepConfigFingerprint("objects", { enabled: false, stub: true });
    const objectsEnabled = buildStepConfigFingerprint("objects", { enabled: true, stub: true });
    assert.notEqual(objectsDisabled, objectsEnabled);

    const audioStub = buildStepConfigFingerprint("audioAnalysis", { stub: true });
    const audioLive = buildStepConfigFingerprint("audioAnalysis", { stub: false });
    assert.notEqual(audioStub, audioLive);

    const keyframesNoImages = buildStepConfigFingerprint("keyframes", { extractImages: false });
    const keyframesWithImages = buildStepConfigFingerprint("keyframes", { extractImages: true });
    assert.notEqual(keyframesNoImages, keyframesWithImages);

    const keyframesSparse = buildStepConfigFingerprint("keyframes", { maxFramesPerMin: 6 });
    const keyframesDense = buildStepConfigFingerprint("keyframes", { maxFramesPerMin: 12 });
    assert.notEqual(keyframesSparse, keyframesDense);
  });

  it("includes twelvelabs index id, live mode hints, and whisper model env", () => {
    const tlStub = buildStepConfigFingerprint("twelvelabs", { useStub: true, twelvelabsLive: false });
    const tlLive = buildStepConfigFingerprint("twelvelabs", { useStub: false, twelvelabsLive: true });
    assert.notEqual(tlStub, tlLive);

    const tlFingerprint = buildStepConfigFingerprint("twelvelabs", { useStub: false, twelvelabsLive: true });
    const tlWithOtherIndex = (() => {
      process.env.TWELVELABS_INDEX_ID = "other-index";
      const fp = buildStepConfigFingerprint("twelvelabs", { useStub: false, twelvelabsLive: true });
      process.env.TWELVELABS_INDEX_ID = "index-test-123";
      return fp;
    })();
    assert.notEqual(tlFingerprint, tlWithOtherIndex);

    const defaultWhisper = buildStepConfigFingerprint("words");
    process.env.OPENAI_WHISPER_MODEL = "whisper-custom";
    const customWhisper = buildStepConfigFingerprint("words");
    assert.notEqual(defaultWhisper, customWhisper);
    delete process.env.OPENAI_WHISPER_MODEL;

    assert.equal(EXPECTED_ARTIFACT_VERSIONS.words, "1.0");
  });

  it("includes expectedTerms in words fingerprint when provided", () => {
    const withoutTerms = buildStepConfigFingerprint("words");
    const withTerms = buildStepConfigFingerprint("words", {
      expectedTerms: ["Elden Ring", "Breaking Bad"],
    });
    assert.notEqual(withoutTerms, withTerms);

    const sameTermsDifferentOrder = buildStepConfigFingerprint("words", {
      expectedTerms: ["Breaking Bad", "Elden Ring"],
    });
    assert.equal(withTerms, sameTermsDifferentOrder);
  });
});
