import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  audioPadSamplesForDuration,
  buildAudioSyncFilter,
  buildCombinedAudioFilter,
  buildLavfiColorInput,
  buildSegmentFfmpegArgs,
  buildVideoSyncFilter,
  collectBrollDesyncWarning,
  resolveWordIndexForSegment,
} from "./ffmpeg-segment.js";
import { buildSpeechAmbientSourcePlan } from "./audio-source-duck.js";
import { resolveEncodeProfile } from "./render-config.js";
import { loadFixtureArtifact } from "../test-helpers/fixture-work-dir.js";
import { buildRenderEdl } from "./build-render-edl.js";
import { resolveRenderContext } from "./resolve-render-context.js";
import {
  copyFixtureToWorkDir,
  cleanupWorkDir,
} from "../test-helpers/fixture-work-dir.js";
import { seedClipSourceFiles } from "../test-helpers/seed-clip-sources.js";

const encodeProfile = resolveEncodeProfile("draft");

const baseSegment = {
  segmentId: "seg_test",
  segmentRole: "aroll",
  videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
  audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
  videoSourcePath: "/tmp/video.mp4",
  audioSourcePath: "/tmp/video.mp4",
  videoInSec: 0,
  videoOutSec: 10,
  audioInSec: 0,
  audioOutSec: 10,
  audioPolicy: "from_video_ref",
  syncMode: "align_start",
  cuts: [],
};

const wordIndex = {
  words: [
    { wordId: "clip01_w0001", word: "hej", start: 0, end: 0.3 },
    { wordId: "clip01_w0002", word: "yyy", start: 0.3, end: 0.6, isFiller: true },
    { wordId: "clip01_w0003", word: "świat", start: 0.6, end: 1.0 },
  ],
};

const context = {
  clips: {
    clip01: { sourcePath: "/tmp/video.mp4", resolution: { w: 1920, h: 1080 } },
    clip02: { sourcePath: "/tmp/broll.mp4", resolution: { w: 1920, h: 1080 } },
  },
  wordIndexes: { clip01: wordIndex },
};

describe("ffmpeg-segment", () => {
  it("resolveWordIndexForSegment prefers audioRef clipId", () => {
    const segment = {
      videoRef: { clipId: "clip02" },
      audioRef: { clipId: "clip01" },
    };
    assert.equal(resolveWordIndexForSegment(segment, context), wordIndex);
  });

  it("collectBrollDesyncWarning returns warning when delta > 0.5s", () => {
    const warning = collectBrollDesyncWarning(
      { segmentId: "seg_b1", segmentRole: "broll" },
      7,
      15,
    );
    assert.equal(warning.code, "broll_av_desync");
    assert.equal(warning.deltaSec, 8);
  });

  it("collectBrollDesyncWarning ignores aroll segments", () => {
    assert.equal(
      collectBrollDesyncWarning({ segmentId: "seg_a1", segmentRole: "aroll" }, 7, 15),
      null,
    );
  });

  it("buildVideoSyncFilter trims when video longer than audio", () => {
    const filter = buildVideoSyncFilter(
      { syncMode: "fit_video_to_audio" },
      10,
      7,
    );
    assert.match(filter, /trim=duration=7/);
  });

  it("buildVideoSyncFilter stretches when video shorter than audio", () => {
    const filter = buildVideoSyncFilter(
      { syncMode: "fit_video_to_audio" },
      7,
      10,
    );
    assert.match(filter, /setpts=PTS\*1\.4285714285714286/);
  });

  it("buildLavfiColorInput encodes black frame duration", () => {
    const input = buildLavfiColorInput(12, { width: 1280, height: 720 });
    assert.match(input, /color=c=black:s=1280x720:r=25:d=12/);
  });

  it("buildSegmentFfmpegArgs uses lavfi color for audio-only narration segment", () => {
    const segment = {
      ...baseSegment,
      segmentId: "seg_vo",
      videoRef: { clipId: "clip03", sceneId: "clip03_scene001" },
      audioRef: { clipId: "clip03", sceneId: "clip03_scene001" },
      videoSourcePath: null,
      audioSourcePath: "/tmp/narration.wav",
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_audio_ref",
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /-f lavfi/);
    assert.match(joined, /color=c=black/);
    assert.match(joined, /\/tmp\/narration\.wav/);
    assert.equal(args.filter((a) => a === "-i").length, 2);
    assert.match(joined, /-map 0:v:0/);
    assert.match(joined, /-map 1:a:0/);
  });

  it("buildSegmentFfmpegArgs uses filter_complex when cuts present", () => {
    const segment = {
      ...baseSegment,
      cuts: [{ startWordId: "clip01_w0002", endWordId: "clip01_w0002", reason: "filler" }],
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /-filter_complex/);
    assert.match(joined, /atrim=/);
    assert.match(joined, /trim=start=/);
    assert.match(joined, /split=2/);
    assert.match(joined, /concat/);
    assert.match(joined, /-map \[vout\]/);
    assert.match(joined, /-map \[aout\]/);
    assert.match(joined, /-shortest/);
  });

  it("buildSegmentFfmpegArgs splits scaled 4K video before dead_air trims", () => {
    const gapWordIndex = {
      words: [
        { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
        { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
      ],
    };
    const fourKContext = {
      clips: {
        clip01: { sourcePath: "/tmp/video-4k.mp4", resolution: { w: 3840, h: 2160 } },
      },
      wordIndexes: { clip01: gapWordIndex },
    };
    const segment = {
      ...baseSegment,
      videoInSec: 0,
      videoOutSec: 8,
      audioInSec: 0,
      audioOutSec: 8,
      cuts: [{ startWordId: "clip01_w001", endWordId: "clip01_w002", reason: "dead_air" }],
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      fourKContext,
      "/tmp/out.mp4",
      {
        encodeProfile,
        dimensions: { width: 1920, height: 1080 },
      },
    );
    const fcIdx = args.indexOf("-filter_complex");
    assert.ok(fcIdx >= 0);
    const graph = args[fcIdx + 1];
    assert.match(graph, /scale=1920:1080/);
    assert.match(graph, /\[vcutin\]split=2/);
    assert.equal((graph.match(/\[vcutin\]trim/g) ?? []).length, 0);
  });

  it("buildSegmentFfmpegArgs adds stream_loop for loop_video", () => {
    const segment = {
      ...baseSegment,
      syncMode: "loop_video",
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 12,
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const loopIdx = args.indexOf("-stream_loop");
    assert.ok(loopIdx >= 0);
    assert.equal(args[loopIdx + 1], "2");
  });

  it("buildSegmentFfmpegArgs applies fit_video_to_audio via -vf", () => {
    const segment = {
      ...baseSegment,
      syncMode: "fit_video_to_audio",
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 7,
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const vfIdx = args.indexOf("-vf");
    assert.ok(vfIdx >= 0);
    assert.match(args[vfIdx + 1], /trim=duration=7/);
  });

  it("buildSegmentFfmpegArgs uses filter_complex for pillarbox_blur vertical broll", () => {
    const verticalContext = {
      ...context,
      clips: {
        ...context.clips,
        clip_vertical: { sourcePath: "/tmp/vertical.mp4", resolution: { w: 1080, h: 1920 } },
      },
    };
    const segment = {
      ...baseSegment,
      segmentId: "seg_vertical_broll",
      segmentRole: "broll",
      videoRef: { clipId: "clip_vertical", sceneId: "clip_vertical_scene001" },
      videoSourcePath: "/tmp/vertical.mp4",
      videoTransform: { fitMode: "pillarbox_blur" },
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      verticalContext,
      "/tmp/out.mp4",
      {
        encodeProfile,
        format: "16:9",
        dimensions: { width: 1920, height: 1080 },
      },
    );
    const fcIdx = args.indexOf("-filter_complex");
    assert.ok(fcIdx >= 0);
    const graph = args[fcIdx + 1];
    assert.match(graph, /split=2/);
    assert.match(graph, /gblur=/);
    assert.ok(!args.includes("-vf"));
  });

  it("buildSegmentFfmpegArgs auto-repairs broll A/V desync", () => {
    const segment = {
      ...baseSegment,
      segmentId: "seg_broll",
      segmentRole: "broll",
      videoRef: { clipId: "clip02" },
      audioRef: { clipId: "clip01" },
      videoSourcePath: "/tmp/broll.mp4",
      audioSourcePath: "/tmp/video.mp4",
      audioPolicy: "from_audio_ref",
      videoInSec: 5,
      videoOutSec: 12,
      audioInSec: 8,
      audioOutSec: 20,
    };
    const { warnings } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, "broll_av_desync_repaired");
  });

  it("buildSegmentFfmpegArgs uses separate audio inputs for broll cross-clip", () => {
    const segment = {
      ...baseSegment,
      segmentRole: "broll",
      videoRef: { clipId: "clip02" },
      audioRef: { clipId: "clip01" },
      videoSourcePath: "/tmp/broll.mp4",
      audioSourcePath: "/tmp/video.mp4",
      audioPolicy: "from_audio_ref",
      videoInSec: 5,
      videoOutSec: 12,
      audioInSec: 8,
      audioOutSec: 15,
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    assert.equal(args.filter((a) => a === "-i").length, 2);
    assert.match(args.join(" "), /-ss 8/);
  });

  it("buildAudioSyncFilter trims audio for fit_audio_to_video", () => {
    const filter = buildAudioSyncFilter(
      { syncMode: "fit_audio_to_video" },
      7,
      10,
    );
    assert.match(filter, /atrim=0:7/);
  });

  it("buildVideoSyncFilter trims video from start for align_end when video longer", () => {
    const filter = buildVideoSyncFilter(
      { syncMode: "align_end" },
      10,
      7,
    );
    assert.match(filter, /trim=start=3:end=10/);
  });

  it("buildVideoSyncFilter pads video at start for align_end when video shorter", () => {
    const filter = buildVideoSyncFilter(
      { syncMode: "align_end" },
      7,
      10,
    );
    assert.match(filter, /tpad=start_duration=3/);
  });

  it("buildAudioSyncFilter trims audio from start for align_end when audio longer", () => {
    const filter = buildAudioSyncFilter(
      { syncMode: "align_end" },
      7,
      10,
    );
    assert.match(filter, /atrim=start=3:end=10/);
  });

  it("buildAudioSyncFilter delays audio for align_end when audio shorter", () => {
    const filter = buildAudioSyncFilter(
      { syncMode: "align_end" },
      10,
      7,
    );
    assert.match(filter, /adelay=3000\|3000/);
  });

  it("audioPadSamplesForDuration respects sample rate", () => {
    assert.equal(audioPadSamplesForDuration(3, 44100), 132300);
    assert.equal(audioPadSamplesForDuration(3), 144000);
  });

  it("buildAudioSyncFilter pads audio for fit_audio_to_video when audio shorter", () => {
    const filter = buildAudioSyncFilter(
      { syncMode: "fit_audio_to_video" },
      10,
      7,
      { sampleRate: 44100 },
    );
    assert.match(filter, /apad=pad_dur=3/);
    assert.match(filter, /atrim=0:10/);
    assert.doesNotMatch(filter, /pad_len=/);
  });

  it("buildSegmentFfmpegArgs applies fit_audio_to_video via -af", () => {
    const segment = {
      ...baseSegment,
      syncMode: "fit_audio_to_video",
      videoInSec: 0,
      videoOutSec: 7,
      audioInSec: 0,
      audioOutSec: 10,
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const afIdx = args.indexOf("-af");
    assert.ok(afIdx >= 0);
    assert.match(args[afIdx + 1], /atrim=0:7/);
  });

  it("buildSegmentFfmpegArgs applies align_end trim on longer video stream", () => {
    const segment = {
      ...baseSegment,
      syncMode: "align_end",
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 7,
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /trim=start=3:end=10/);
    assert.match(joined, /adelay=3000\|3000/);
  });

  it("buildSegmentFfmpegArgs applies align_end trim on longer audio stream", () => {
    const segment = {
      ...baseSegment,
      syncMode: "align_end",
      videoInSec: 0,
      videoOutSec: 7,
      audioInSec: 0,
      audioOutSec: 10,
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /atrim=start=3:end=10/);
    assert.match(joined, /tpad=start_duration=3/);
  });

  it("buildSegmentFfmpegArgs uses video range for video cuts on broll", () => {
    const brollWordIndex = {
      words: [
        { wordId: "clip01_w0010", word: "jedzenie", start: 7.0, end: 7.3 },
      ],
    };
    const brollContext = {
      ...context,
      wordIndexes: { ...context.wordIndexes, clip01: brollWordIndex },
    };
    const segment = {
      ...baseSegment,
      segmentRole: "broll",
      videoRef: { clipId: "clip02" },
      audioRef: { clipId: "clip01" },
      videoSourcePath: "/tmp/broll.mp4",
      audioSourcePath: "/tmp/video.mp4",
      audioPolicy: "from_audio_ref",
      videoInSec: 2,
      videoOutSec: 12,
      audioInSec: 5,
      audioOutSec: 15,
      cuts: [{ startWordId: "clip01_w0010", endWordId: "clip01_w0010", reason: "filler" }],
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      brollContext,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const fcIdx = args.indexOf("-filter_complex");
    assert.ok(fcIdx >= 0);
    const graph = args[fcIdx + 1];
    assert.match(graph, /trim=start=0:end=5/);
    assert.match(graph, /trim=start=5\.3:end=10/);
    assert.match(graph, /atrim=0:2/);
    assert.match(graph, /atrim=2\.3:10/);
  });

  it("buildSegmentFfmpegArgs embeds audio for from_prev segment (JL-cut remainder)", () => {
    const segment = {
      ...baseSegment,
      audioPolicy: "from_prev",
      overlapSec: 0.5,
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.doesNotMatch(joined, /-an/);
    assert.doesNotMatch(joined, /anullsrc/);
    assert.equal(args.filter((a) => a === "-i").length, 1);
    assert.ok(args.indexOf("-c:a") >= 0);
    assert.ok(args.includes("0:a:0?"));
  });

  it("buildSegmentFfmpegArgs uses -an for from_next segment (video-only)", () => {
    const segment = {
      ...baseSegment,
      audioPolicy: "from_next",
      overlapSec: 0.5,
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /-an/);
    assert.doesNotMatch(joined, /anullsrc/);
    assert.equal(args.filter((a) => a === "-i").length, 1);
    assert.equal(args.indexOf("-c:a"), -1);
  });

  it("buildSegmentFfmpegArgs applies golden recipe cuts with atrim/concat", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-seg-cuts" });
    try {
      seedClipSourceFiles(workDir);
      const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
      const context = resolveRenderContext(workDir, recipe);
      const output = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
      const edl = buildRenderEdl(output, recipe, context);
      const segH1 = edl.segments.find((seg) => seg.segmentId === "seg_h1");
      assert.ok(segH1?.cuts?.length);

      const { args } = buildSegmentFfmpegArgs(
        segH1,
        context,
        "/tmp/out.mp4",
        { encodeProfile },
      );
      const joined = args.join(" ");
      assert.match(joined, /-filter_complex/);
      assert.match(joined, /atrim=/);
      assert.match(joined, /trim=start=/);
      assert.match(joined, /concat/);
      assert.match(joined, /-map \[vout\]/);
      assert.match(joined, /-map \[aout\]/);
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("buildSegmentFfmpegArgs applies atempo when videoTransform.speed is set", () => {
    const segment = {
      ...baseSegment,
      videoTransform: { speed: 1.5, speedMode: "video_audio" },
    };
    const { args, targetDur } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /atempo=1\.5/);
    assert.match(joined, /setpts=PTS\/1\.5/);
    assert.equal(targetDur, 10 / 1.5);
  });

  it("buildSegmentFfmpegArgs skips atempo for video_only speedMode", () => {
    const segment = {
      ...baseSegment,
      videoTransform: { speed: 2, speedMode: "video_only" },
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.doesNotMatch(joined, /atempo=/);
    assert.match(joined, /setpts=PTS\/2/);
  });

  it("buildSegmentFfmpegArgs pads video for video_only when sped video is shorter than audio", () => {
    const segment = {
      ...baseSegment,
      videoInSec: 0,
      videoOutSec: 6,
      audioInSec: 0,
      audioOutSec: 10,
      videoTransform: { speed: 2, speedMode: "video_only" },
    };
    const { args, targetDur } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /tpad=stop_mode=clone:stop_duration=7/);
    assert.doesNotMatch(joined, /-shortest/);
    assert.equal(targetDur, 10);
    const tIdx = args.indexOf("-t");
    assert.ok(tIdx >= 0);
    assert.equal(args[tIdx + 1], "10");
  });

  it("buildSegmentFfmpegArgs applies sourceVolumeDb filter", () => {
    const segment = {
      ...baseSegment,
      sourceVolumeDb: -6,
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const afIdx = args.indexOf("-af");
    assert.ok(afIdx >= 0);
    assert.match(args[afIdx + 1], /volume=0\.5011872336272722/);
  });

  it("buildSegmentFfmpegArgs applies fit_video_to_audio after speed transform", () => {
    const segment = {
      ...baseSegment,
      syncMode: "fit_video_to_audio",
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 7,
      videoTransform: { speed: 2 },
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /trim=duration=3\.5/);
    assert.match(joined, /setpts=PTS\/2/);
    assert.match(joined, /atempo=2/);
  });

  it("buildCombinedAudioFilter chains atempo before fit sync when speed set", () => {
    const filter = buildCombinedAudioFilter(
      {
        syncMode: "fit_audio_to_video",
        audioPolicy: "from_video_ref",
        videoTransform: { speed: 2 },
        sourceVolumeDb: -6,
      },
      10,
      7,
    );
    assert.match(filter, /atempo=2,apad=pad_dur=1\.5/);
    assert.match(filter, /volume=0\.5011872336272722/);
  });

  it("buildSegmentFfmpegArgs applies reverse filter and mutes audio", () => {
    const segment = {
      ...baseSegment,
      videoTransform: { playbackMode: "reverse" },
      audioPolicy: "mute",
    };
    const { args, targetDur } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /reverse/);
    assert.match(joined, /-an/);
    assert.equal(targetDur, 10);
  });

  it("buildSegmentFfmpegArgs applies boomerang trim+reverse+concat and shortens output", () => {
    const segment = {
      ...baseSegment,
      videoInSec: 0,
      videoOutSec: 8,
      audioInSec: 0,
      audioOutSec: 8,
      videoTransform: { playbackMode: "boomerang", boomerangHalfSec: 1.5 },
      audioPolicy: "mute",
    };
    const { args, targetDur } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /-filter_complex/);
    assert.match(joined, /trim=0:1\.5000/);
    assert.match(joined, /concat=n=2:v=1:a=0/);
    assert.match(joined, /-an/);
    assert.equal(targetDur, 3);
  });

  it("buildSegmentFfmpegArgs mutes audio for reverse even without explicit audioPolicy", () => {
    const segment = {
      ...baseSegment,
      videoTransform: { playbackMode: "reverse" },
      audioPolicy: "from_video_ref",
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /-an/);
    assert.doesNotMatch(joined, /-af /);
  });

  it("buildSegmentFfmpegArgs dual-inputs enhanced+original with source duck graph", () => {
    const plan = buildSpeechAmbientSourcePlan(
      {
        audioInSec: 0,
        audioOutSec: 10,
        preserveAmbientAudio: false,
      },
      [
        { text: "hello", start: 1.0, end: 1.5 },
        { text: "world", start: 1.6, end: 2.0 },
      ],
      "/tmp/enhanced.wav",
      "/tmp/video.mp4",
    );
    assert.equal(plan.mode, "speech_ambient_duck");

    const segment = {
      ...baseSegment,
      audioSourcePath: "/tmp/enhanced.wav",
      audioSourceDuck: plan,
      audioSourceOriginalPath: "/tmp/video.mp4",
      audioSourceEnhancedPath: "/tmp/enhanced.wav",
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      context,
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const joined = args.join(" ");
    assert.match(joined, /-i \/tmp\/enhanced\.wav/);
    assert.match(joined, /-i \/tmp\/video\.mp4/);
    assert.match(joined, /-filter_complex/);
    assert.match(joined, /amix=inputs=2:duration=first:normalize=0:dropout_transition=0\.06/);
    assert.match(joined, /\[enhg\]\[origg\]amix/);
    assert.match(joined, /-map \[vout\]/);
    assert.match(joined, /-map \[aout\]/);
  });

  it("buildSegmentFfmpegArgs source-duck + multi cuts asplits [aduck] before atrim", () => {
    const plan = buildSpeechAmbientSourcePlan(
      {
        audioInSec: 0,
        audioOutSec: 10,
        preserveAmbientAudio: false,
      },
      [
        { text: "hello", start: 1.0, end: 1.5 },
        { text: "world", start: 5.0, end: 5.5 },
      ],
      "/tmp/enhanced.wav",
      "/tmp/video.mp4",
    );
    assert.equal(plan.mode, "speech_ambient_duck");

    const cutWords = {
      words: [
        { wordId: "w1", word: "a", start: 0, end: 1 },
        { wordId: "w2", word: "b", start: 1, end: 2, isFiller: true },
        { wordId: "w3", word: "c", start: 2, end: 3 },
        { wordId: "w4", word: "d", start: 3, end: 4, isFiller: true },
        { wordId: "w5", word: "e", start: 4, end: 10 },
      ],
    };
    const segment = {
      ...baseSegment,
      audioSourcePath: "/tmp/enhanced.wav",
      audioSourceDuck: plan,
      audioSourceOriginalPath: "/tmp/video.mp4",
      audioSourceEnhancedPath: "/tmp/enhanced.wav",
      cuts: [
        { cutId: "c1", type: "filler", startWordId: "w2", endWordId: "w2" },
        { cutId: "c2", type: "filler", startWordId: "w4", endWordId: "w4" },
      ],
    };
    const { args } = buildSegmentFfmpegArgs(
      segment,
      { wordIndexes: { clip01: cutWords } },
      "/tmp/out.mp4",
      { encodeProfile },
    );
    const fc = args[args.indexOf("-filter_complex") + 1];
    assert.match(fc, /\[aduck\]asplit=3/);
    assert.equal((fc.match(/\[aduck\]atrim/g) ?? []).length, 0);
    assert.match(fc, /\[as0\]atrim=/);
    assert.match(fc, /amix=inputs=2/);
  });
});
