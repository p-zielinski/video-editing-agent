import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adjustDurationForSpeed,
  buildAtempoFilterChain,
  buildSourceVolumeFilter,
  buildVideoOnlyPadFilter,
  resolveEffectiveSpeed,
  resolveSpedMediaDurations,
  shouldApplyAudioSpeed,
  shouldOmitShortestForVideoOnlySpeed,
} from "./speed-transform.js";

describe("speed-transform", () => {
  it("resolveEffectiveSpeed defaults to 1", () => {
    assert.equal(resolveEffectiveSpeed({}), 1);
    assert.equal(resolveEffectiveSpeed({ videoTransform: {} }), 1);
    assert.equal(resolveEffectiveSpeed({ videoTransform: { speed: 2 } }), 2);
  });

  it("adjustDurationForSpeed divides by speed when not 1", () => {
    assert.equal(adjustDurationForSpeed(10, 1), 10);
    assert.equal(adjustDurationForSpeed(10, 2), 5);
    assert.equal(adjustDurationForSpeed(10, 0.5), 20);
  });

  it("buildAtempoFilterChain returns single atempo within 0.5-2.0", () => {
    assert.equal(buildAtempoFilterChain(1.5), "atempo=1.5");
    assert.equal(buildAtempoFilterChain(0.75), "atempo=0.75");
  });

  it("buildAtempoFilterChain chains atempo for speed > 2", () => {
    assert.match(buildAtempoFilterChain(4), /atempo=2\.0,atempo=2(\.0)?/);
    assert.equal(buildAtempoFilterChain(3), "atempo=2.0,atempo=1.5");
  });

  it("buildAtempoFilterChain chains atempo for speed < 0.5", () => {
    assert.equal(buildAtempoFilterChain(0.25), "atempo=0.5,atempo=0.5");
  });

  it("resolveSpedMediaDurations adjusts video and audio after speed", () => {
    const segment = { audioPolicy: "from_video_ref", videoTransform: { speed: 2 } };
    const { spedVideoDur, spedAudioDur } = resolveSpedMediaDurations(segment, 10, 8);
    assert.equal(spedVideoDur, 5);
    assert.equal(spedAudioDur, 4);
  });

  it("shouldApplyAudioSpeed respects audioPolicy and speedMode", () => {
    const base = { audioPolicy: "from_video_ref" };
    assert.equal(shouldApplyAudioSpeed(base, 1), false);
    assert.equal(shouldApplyAudioSpeed(base, 2), true);
    assert.equal(shouldApplyAudioSpeed({ audioPolicy: "from_prev" }, 2), false);
    assert.equal(shouldApplyAudioSpeed({ audioPolicy: "mute" }, 2), false);
    assert.equal(
      shouldApplyAudioSpeed({
        audioPolicy: "from_video_ref",
        videoTransform: { speed: 2, speedMode: "video_only" },
      }, 2),
      false,
    );
    assert.equal(shouldApplyAudioSpeed({ audioPolicy: "from_audio_ref" }, 1.5), true);
  });

  it("buildSourceVolumeFilter converts dB to linear gain", () => {
    assert.equal(buildSourceVolumeFilter(null), null);
    assert.equal(buildSourceVolumeFilter(0), null);
    assert.match(buildSourceVolumeFilter(-6), /^volume=0\.501/);
    assert.match(buildSourceVolumeFilter(6), /^volume=1\.995/);
  });

  it("buildVideoOnlyPadFilter pads when sped video is shorter than audio", () => {
    const filter = buildVideoOnlyPadFilter(
      { videoTransform: { speed: 2, speedMode: "video_only" }, audioPolicy: "from_video_ref" },
      6,
      10,
    );
    assert.match(filter, /tpad=stop_mode=clone:stop_duration=7/);
  });

  it("buildVideoOnlyPadFilter returns null when sped video covers audio", () => {
    assert.equal(
      buildVideoOnlyPadFilter(
        { videoTransform: { speed: 2, speedMode: "video_only" }, audioPolicy: "from_video_ref" },
        20,
        10,
      ),
      null,
    );
  });

  it("shouldOmitShortestForVideoOnlySpeed is true only for video_only speed", () => {
    assert.equal(
      shouldOmitShortestForVideoOnlySpeed({ videoTransform: { speed: 2, speedMode: "video_only" } }),
      true,
    );
    assert.equal(
      shouldOmitShortestForVideoOnlySpeed({ videoTransform: { speed: 2, speedMode: "video_audio" } }),
      false,
    );
    assert.equal(shouldOmitShortestForVideoOnlySpeed({ videoTransform: { speed: 1 } }), false);
  });
});
