import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPlaybackToVideoFilter,
  buildPlaybackVideoFilter,
  resolveBoomerangHalfSec,
  resolvePlaybackOutputDuration,
  shouldMutePlaybackAudio,
} from "./playback-transform.js";

describe("playback-transform", () => {
  it("resolveBoomerangHalfSec clamps to half span and max cap", () => {
    assert.equal(
      resolveBoomerangHalfSec({ videoTransform: { boomerangHalfSec: 6 } }, 10),
      4,
    );
    assert.equal(
      resolveBoomerangHalfSec({ videoTransform: { boomerangHalfSec: 1.5 } }, 10),
      1.5,
    );
    assert.equal(
      resolveBoomerangHalfSec({ videoTransform: {} }, 2),
      1,
    );
  });

  it("resolvePlaybackOutputDuration doubles boomerang half", () => {
    const dur = resolvePlaybackOutputDuration(
      { videoTransform: { playbackMode: "boomerang", boomerangHalfSec: 1.5 } },
      10,
      10,
    );
    assert.equal(dur, 3);
  });

  it("resolvePlaybackOutputDuration leaves reverse duration unchanged", () => {
    assert.equal(
      resolvePlaybackOutputDuration(
        { videoTransform: { playbackMode: "reverse" } },
        10,
        8,
      ),
      8,
    );
  });

  it("shouldMutePlaybackAudio for reverse and boomerang", () => {
    assert.equal(shouldMutePlaybackAudio({ videoTransform: { playbackMode: "reverse" } }), true);
    assert.equal(shouldMutePlaybackAudio({ videoTransform: { playbackMode: "boomerang" } }), true);
    assert.equal(shouldMutePlaybackAudio({ videoTransform: { playbackMode: "normal" } }), false);
  });

  it("buildPlaybackVideoFilter builds reverse and boomerang graphs", () => {
    assert.match(buildPlaybackVideoFilter("reverse", 0, "[vbase]"), /\[vbase\]reverse/);
    const boom = buildPlaybackVideoFilter("boomerang", 1.5, "[vbase]");
    assert.match(boom, /trim=0:1\.5000/);
    assert.match(boom, /concat=n=2:v=1:a=0/);
  });

  it("applyPlaybackToVideoFilter upgrades vf chain to filter_complex for boomerang", () => {
    const result = applyPlaybackToVideoFilter(
      { mode: "vf", chain: "setpts=PTS-STARTPTS" },
      { videoTransform: { playbackMode: "boomerang", boomerangHalfSec: 1 } },
      8,
    );
    assert.equal(result.mode, "filter_complex");
    assert.match(result.graph, /concat=n=2:v=1:a=0/);
  });
});
