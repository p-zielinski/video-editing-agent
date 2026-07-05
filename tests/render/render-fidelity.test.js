import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isMultiSegmentCrossfadeEligible,
  buildMultiSegmentXfadeFilterComplex,
  getCrossfadeNotAppliedReason,
} from "../../src/render/ffmpeg-concat.js";
import {
  buildCombinedAudioFilter,
  buildVideoSyncFilter,
} from "../../src/render/ffmpeg-segment.js";
import { resolveSpedMediaDurations } from "../../src/render/speed-transform.js";
import { buildJlVideoInputFilter } from "../../src/render/audio-jlcut.js";
import { projectChapterCardOverlays } from "../../src/render/enrich-render-edl.js";

describe("render-fidelity Phase 3B", () => {
  it("partial crossfade on 4 segments is eligible and composes mixed joins", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 10 },
      { outputStartSec: 10, outputEndSec: 20 },
      { outputStartSec: 20, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 40 },
    ];
    const moments = [
      { techniqueId: "crossfade", outputStartSec: 10, outputEndSec: 10.3 },
      { techniqueId: "crossfade", outputStartSec: 20, outputEndSec: 20.3 },
    ];
    const paths = ["a.mp4", "b.mp4", "c.mp4", "d.mp4"];

    assert.equal(isMultiSegmentCrossfadeEligible(paths, segments, moments), true);
    assert.equal(getCrossfadeNotAppliedReason(paths, segments, moments), null);

    const built = buildMultiSegmentXfadeFilterComplex({
      segmentDurations: [10, 10, 10, 10],
      crossfadeAtBoundaries: [
        { durationSec: 0.3 },
        { durationSec: 0.3 },
        null,
      ],
    });
    assert.ok(built.filterComplex.includes("xfade=transition=fade"));
    assert.ok(built.filterComplex.includes("concat=n=2:v=1:a=0"));
  });

  it("speed then fit sync uses sped durations for video and audio", () => {
    const segment = { audioPolicy: "from_video_ref", videoTransform: { speed: 2 } };
    const { spedVideoDur, spedAudioDur } = resolveSpedMediaDurations(segment, 10, 7);
    assert.equal(spedVideoDur, 5);
    assert.equal(spedAudioDur, 3.5);

    const videoFit = buildVideoSyncFilter(
      { syncMode: "fit_video_to_audio" },
      spedVideoDur,
      spedAudioDur,
    );
    assert.match(videoFit, /trim=duration=3\.5/);

    const audioFit = buildCombinedAudioFilter(
      { syncMode: "fit_audio_to_video", audioPolicy: "from_video_ref", videoTransform: { speed: 2 } },
      10,
      7,
    );
    assert.match(audioFit, /atempo=2,apad=pad_dur=1\.5/);
  });

  it("J/L video filters trim L-cut start and pad J-cut end", () => {
    const segments = [
      { audioPolicy: "from_next", overlapSec: 1, outputStartSec: 0, outputEndSec: 10 },
      { audioPolicy: "from_prev", overlapSec: 1, outputStartSec: 10, outputEndSec: 20 },
    ];

    assert.match(buildJlVideoInputFilter(0, segments), /tpad=stop_mode=clone:stop_duration=1/);
    assert.match(buildJlVideoInputFilter(1, segments), /trim=start=1/);
  });

  it("chapter_card creativeMoments project to textOverlays", () => {
    const segments = [{ segmentId: "s1", outputStartSec: 0, outputEndSec: 60, textOverlays: [] }];
    const enriched = projectChapterCardOverlays(segments, [{
      techniqueId: "chapter_card",
      outputId: "short_9x16",
      outputStartSec: 45,
      outputEndSec: 47,
      params: { label: "Part 2" },
    }], "short_9x16");

    assert.equal(enriched[0].textOverlays[0].style, "chapter_card");
    assert.equal(enriched[0].textOverlays[0].role, "chapter");
    assert.equal(enriched[0].textOverlays[0].text, "Part 2");
  });
});
