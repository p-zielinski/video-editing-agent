import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBrollAutoSyncRepair,
  collectBrollDesyncWarning,
} from "./ffmpeg-segment.js";

describe("broll auto-sync repair", () => {
  it("resolveBrollAutoSyncRepair returns fit_video_to_audio when desync > 0.5s", () => {
    const segment = { segmentId: "b1", segmentRole: "broll", syncMode: "align_start" };
    const repair = resolveBrollAutoSyncRepair(segment, 12, 10);
    assert.ok(repair);
    assert.equal(repair.syncMode, "fit_video_to_audio");
    assert.equal(repair.code, "broll_av_desync_repaired");
  });

  it("collectBrollDesyncWarning still reports when no auto repair applied", () => {
    const segment = { segmentId: "b1", segmentRole: "broll", syncMode: "fit_audio_to_video" };
    const warning = collectBrollDesyncWarning(segment, 12, 10);
    assert.ok(warning);
    assert.equal(resolveBrollAutoSyncRepair(segment, 12, 10), null);
  });
});
