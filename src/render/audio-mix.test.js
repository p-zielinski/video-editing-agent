import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildLoudnormFilter,
  buildSidechainCompressFilter,
  buildAudioMixFilterGraph,
  buildMusicBedMomentVolumeFilter,
  buildVoiceMomentVolumeFilter,
  buildVoicePitchShiftFilter,
  computePitchShiftSampleRate,
  fillDuckingWindowGaps,
  resolveDuckingWindows,
  resolveDuckingWindowsWithSource,
  resolveMusicBedMoments,
  resolveVoiceAudioMoments,
  hasAudioMixMoments,
  resolveSfxPath,
  resolveSfxPlanEntries,
  applyAudioMix,
  resolveAudioCensorshipWindows,
  buildVoiceCensorshipMuteFilter,
  resolveBleepSfxEntries,
  outputHasAudioCensorship,
  PROFANITY_BLEEP_SFX_ID,
  shouldLoopMusicBed,
  buildMusicBedInputArgs,
  resolveMusicBedRequiredSec,
} from "./audio-mix.js";
import { AudioMixDuckingWindowSchema, AudioMixSegmentSchema } from "../schemas/edit-recipe-v2.js";
import { validateAudioMixPlan } from "../validators/recipe-v2.js";
import { resolveFfmpegBins } from "../lib/ffmpeg-bin.js";
import { resolveEncodeProfile } from "./render-config.js";

function tempAudioPath(suffix = ".wav") {
  return path.join(os.tmpdir(), `vea-audio-mix-test-${process.pid}-${Date.now()}${suffix}`);
}

describe("audio-mix", () => {
  it("buildLoudnormFilter includes two-pass measurement fields", () => {
    const filter = buildLoudnormFilter(
      {
        integratedLufs: -20.5,
        truePeakDb: -3.2,
        lra: 8.1,
        threshold: -31.0,
        targetOffset: 4.5,
      },
      { targetLufs: -16 },
    );
    assert.ok(filter.startsWith("loudnorm="));
    assert.ok(filter.includes("I=-16"));
    assert.ok(filter.includes("measured_I=-20.5"));
    assert.ok(filter.includes("measured_TP=-3.2"));
    assert.ok(filter.includes("measured_LRA=8.1"));
    assert.ok(filter.includes("measured_thresh=-31"));
    assert.ok(filter.includes("offset=4.5"));
    assert.ok(filter.includes("linear=true"));
  });

  it("buildSidechainCompressFilter scales ratio with duckingDb depth", () => {
    const mild = buildSidechainCompressFilter(-12);
    const strong = buildSidechainCompressFilter(-18);

    assert.ok(mild.includes("ratio=6.0"));
    assert.ok(mild.includes("threshold=0.050"));
    assert.ok(strong.includes("ratio=9.0"));
    assert.ok(strong.includes("threshold=0.033"));
    assert.notEqual(mild, strong);
  });

  it("buildSidechainCompressFilter defaults duckingDb to -12 when missing", () => {
    const defaulted = buildSidechainCompressFilter();
    const explicit = buildSidechainCompressFilter(-12);
    assert.equal(defaulted, explicit);
  });

  it("resolveDuckingWindows falls back to musicBed.duckingDb when segment omits override", () => {
    const windows = resolveDuckingWindows(
      { duckUnderVoice: true },
      { musicBed: { duckingDb: -14 } },
    );
    assert.deepEqual(windows, [{ startSec: 0, endSec: null, duckingDb: -14 }]);
  });

  it("resolveDuckingWindows uses segment.duckingDb override over global bed", () => {
    const windows = resolveDuckingWindows(
      { duckUnderVoice: true, duckingDb: -8 },
      { musicBed: { duckingDb: -14 } },
    );
    assert.deepEqual(windows, [{ startSec: 0, endSec: null, duckingDb: -8 }]);
  });

  it("resolveDuckingWindows expands segment.duckingWindows per output timeline", () => {
    const windows = resolveDuckingWindows(
      {
        duckUnderVoice: true,
        duckingWindows: [
          { startSec: 0, endSec: 30, duckingDb: -12 },
          { startSec: 30, endSec: 60, duckingDb: -6 },
        ],
      },
      { musicBed: { duckingDb: -14 } },
    );
    assert.deepEqual(windows, [
      { startSec: 0, endSec: 30, duckingDb: -12 },
      { startSec: 30, endSec: 60, duckingDb: -6 },
    ]);
  });

  it("resolveDuckingWindowsWithSource reports director vs fallback provenance", () => {
    const director = resolveDuckingWindowsWithSource(
      {
        duckUnderVoice: true,
        duckingWindows: [{ startSec: 0, endSec: 10, duckingDb: -12 }],
      },
      { musicBed: { duckingDb: -14 } },
    );
    assert.equal(director.source, "director");
    assert.equal(director.windows.length, 1);

    const fallback = resolveDuckingWindowsWithSource(
      { duckUnderVoice: true },
      { musicBed: { duckingDb: -14 } },
    );
    assert.equal(fallback.source, "fallback");
  });

  it("fillDuckingWindowGaps inserts no-duck windows for uncovered regions", () => {
    const filled = fillDuckingWindowGaps([
      { startSec: 10, endSec: 30, duckingDb: -12 },
      { startSec: 40, endSec: 50, duckingDb: -6 },
    ], 60);

    assert.deepEqual(filled, [
      { startSec: 0, endSec: 10, duckingDb: 0 },
      { startSec: 10, endSec: 30, duckingDb: -12 },
      { startSec: 30, endSec: 40, duckingDb: 0 },
      { startSec: 40, endSec: 50, duckingDb: -6 },
      { startSec: 50, endSec: 60, duckingDb: 0 },
    ]);
  });

  it("resolveDuckingWindows auto-fills gaps when musicOutSec is set", () => {
    const windows = resolveDuckingWindows(
      {
        duckUnderVoice: true,
        musicOutSec: 60,
        duckingWindows: [
          { startSec: 0, endSec: 30, duckingDb: -12 },
          { startSec: 30, endSec: 50, duckingDb: -6 },
        ],
      },
      { musicBed: { duckingDb: -14 } },
    );

    assert.deepEqual(windows, [
      { startSec: 0, endSec: 30, duckingDb: -12 },
      { startSec: 30, endSec: 50, duckingDb: -6 },
      { startSec: 50, endSec: 60, duckingDb: 0 },
    ]);
  });

  it("AudioMixDuckingWindowSchema rejects inverted startSec >= endSec", () => {
    assert.throws(
      () => AudioMixDuckingWindowSchema.parse({ startSec: 30, endSec: 10, duckingDb: -12 }),
      /startSec must be less than endSec/,
    );
  });

  it("AudioMixSegmentSchema rejects duckingWindows arrays longer than 16", () => {
    const windows = Array.from({ length: 17 }, (_, i) => ({
      startSec: i * 2,
      endSec: i * 2 + 1,
      duckingDb: -12,
    }));
    assert.throws(
      () => AudioMixSegmentSchema.parse({
        outputId: "main_16x9",
        duckUnderVoice: true,
        duckingWindows: windows,
      }),
      /Array must contain at most 16 element/,
    );
  });

  it("validateAudioMixPlan warns V24-09 when duckingWindows exceeds 16", () => {
    const windows = Array.from({ length: 17 }, (_, i) => ({
      startSec: i * 2,
      endSec: i * 2 + 1,
      duckingDb: -12,
    }));
    const issues = validateAudioMixPlan({
      audioMixPlan: {
        segments: [{
          outputId: "main_16x9",
          duckUnderVoice: true,
          duckingWindows: windows,
        }],
      },
      outputs: [{ outputId: "main_16x9", timeline: [] }],
    });
    assert.ok(issues.some((i) => i.code === "V24-09" && i.severity === "warning"));
  });

  it("buildAudioMixFilterGraph applies per-window duckingDb on music bed (0-30s -12dB, 30-60s -6dB)", () => {
    const graph = buildAudioMixFilterGraph({
      plan: { musicBed: { volumeDb: -18, duckingDb: -14 } },
      mixSegment: {
        duckUnderVoice: true,
        duckingWindows: [
          { startSec: 0, endSec: 30, duckingDb: -12 },
          { startSec: 30, endSec: 60, duckingDb: -6 },
        ],
      },
      bedPath: "/tmp/bed.mp3",
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
    });

    const scFilters = graph.filters.filter((f) => f.includes("sidechaincompress"));
    assert.equal(scFilters.length, 2);
    assert.ok(scFilters[0].includes("ratio=6.0"), "0-30s window should duck -12dB");
    assert.ok(scFilters[1].includes("ratio=3.0"), "30-60s window should duck -6dB");
    assert.ok(graph.filters.some((f) => f.includes("gte(t\\,0)*lt(t\\,30)")));
    assert.ok(graph.filters.some((f) => f.includes("gte(t\\,30)*lt(t\\,60)")));
    assert.ok(graph.filters.some((f) => f.includes("asplit=2")));
    assert.ok(graph.filters.some((f) => f.includes("amix=inputs=2")));
  });

  it("buildAudioMixFilterGraph embeds ducking-derived sidechaincompress params", () => {
    const mild = buildAudioMixFilterGraph({
      plan: { musicBed: { volumeDb: -18, duckingDb: -12 } },
      mixSegment: { duckUnderVoice: true },
      bedPath: "/tmp/bed.mp3",
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
    });
    const strong = buildAudioMixFilterGraph({
      plan: { musicBed: { volumeDb: -18, duckingDb: -18 } },
      mixSegment: { duckUnderVoice: true },
      bedPath: "/tmp/bed.mp3",
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
    });

    const mildSc = mild.filters.find((f) => f.includes("sidechaincompress"));
    const strongSc = strong.filters.find((f) => f.includes("sidechaincompress"));
    assert.ok(mildSc?.includes("ratio=6.0"));
    assert.ok(strongSc?.includes("ratio=9.0"));
    assert.notEqual(mildSc, strongSc);
  });

  it("buildAudioMixFilterGraph applies loudnorm on voice before ducking", () => {
    const graph = buildAudioMixFilterGraph({
      plan: { musicBed: { volumeDb: -18, duckingDb: -12 } },
      mixSegment: { duckUnderVoice: true },
      bedPath: "/tmp/bed.mp3",
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
    });

    assert.equal(graph.needsMix, true);
    assert.ok(graph.filters[0].includes("loudnorm=I=-16"));
    assert.ok(graph.filters[0].includes("[voice]"));
    assert.ok(graph.filters.some((f) => f.includes("sidechaincompress")));
    assert.ok(graph.filters.some((f) => f.includes("amix=inputs=2")));
  });

  it("buildAudioMixFilterGraph voice-only loudnorm without amix", () => {
    const graph = buildAudioMixFilterGraph({
      plan: { voiceTargetLufs: -16 },
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
    });

    assert.equal(graph.needsMix, true);
    assert.equal(graph.voiceOnly, true);
    assert.equal(graph.filters.length, 1);
    assert.ok(graph.filters[0].includes("[voice]"));
    assert.ok(!graph.filters.some((f) => f.includes("amix")));
  });

  it("buildAudioMixFilterGraph returns needsMix false when no processing", () => {
    const graph = buildAudioMixFilterGraph({});
    assert.equal(graph.needsMix, false);
    assert.deepEqual(graph.filters, []);
  });

  it("buildVoiceCensorshipMuteFilter mutes voice during censorship windows", () => {
    const filter = buildVoiceCensorshipMuteFilter("[voice_base]", "[voice]", [
      { startSec: 1.0, endSec: 1.4, mode: "bleep" },
      { startSec: 2.0, endSec: 2.5, mode: "mute" },
    ]);
    assert.ok(filter.includes("between(t\\,1\\,1.4)"));
    assert.ok(filter.includes("between(t\\,2\\,2.5)"));
    assert.ok(filter.includes("volume='if("));
  });

  it("resolveAudioCensorshipWindows collects segment windows", () => {
    const output = {
      timeline: [{
        audioCensorship: [{ startSec: 1, endSec: 1.5, mode: "bleep" }],
      }, {
        audioCensorship: [{ startSec: 3, endSec: 3.2, mode: "mute" }],
      }],
    };
    assert.equal(resolveAudioCensorshipWindows(output).length, 2);
    assert.equal(outputHasAudioCensorship(output), true);
  });

  it("resolveBleepSfxEntries maps bleep windows to SFX overlays", () => {
    const entries = resolveBleepSfxEntries([
      { startSec: 1, endSec: 1.4, mode: "bleep" },
      { startSec: 2, endSec: 2.5, mode: "mute" },
    ]);
    assert.equal(entries.length, 1);
    const bleepPath = resolveSfxPath(entries[0].sfxId);
    assert.ok(bleepPath, "bleep SFX must resolve from catalog");
    assert.equal(entries[0].outputStartSec, 1);
    assert.ok(entries[0].durationSec > 0);
  });

  it("buildAudioMixFilterGraph applies censorship mute and bleep SFX", () => {
    const entries = resolveBleepSfxEntries([{ startSec: 1, endSec: 1.4, mode: "bleep" }]);
    const bleepPath = resolveSfxPath(entries[0].sfxId);
    assert.ok(bleepPath);

    const graph = buildAudioMixFilterGraph({
      censorshipWindows: [{ startSec: 1, endSec: 1.4, mode: "bleep" }],
      sfxEntries: [{
        volumeDb: entries[0].volumeDb,
        outputStartSec: entries[0].outputStartSec,
        durationSec: entries[0].durationSec,
        resolvedPath: bleepPath,
      }],
    });

    assert.equal(graph.needsMix, true);
    assert.ok(graph.filters.some((f) => f.includes("between(t\\,1\\,1.4)")));
    assert.ok(graph.filters.some((f) => f.includes("adelay=1000|1000")));
    assert.ok(graph.filters.some((f) => f.includes("atrim=0:")));
  });

  it("buildAudioMixFilterGraph overlays sfxPlan library entries via resolveSfxPath", () => {
    const whooshPath = resolveSfxPath("whoosh") ?? tempAudioPath();
    if (!fs.existsSync(whooshPath)) {
      fs.writeFileSync(whooshPath, "");
    }

    const graph = buildAudioMixFilterGraph({
      plan: { voiceTargetLufs: -16 },
      sfxEntries: [{
        volumeDb: -6,
        outputStartSec: 1.5,
        resolvedPath: whooshPath,
      }],
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
    });

    assert.equal(graph.needsMix, true);
    assert.ok(graph.filters.some((f) => f.includes("adelay=1500|1500")));
    assert.ok(graph.filters.some((f) => f.includes("amix=inputs=2")));
  });

  it("buildAudioMixFilterGraph overlays audio_event entries with atrim and adelay", () => {
    const graph = buildAudioMixFilterGraph({
      plan: { voiceTargetLufs: -16 },
      sfxEntries: [{
        source: "audio_event",
        clipId: "clip01",
        anchorTimeSec: 8.5,
        outputStartSec: 5,
        outputEndSec: 6.2,
        sourcePath: "/mock/inbox/01_talk.MOV",
        durationSec: 1.2,
        volumeDb: -6,
      }],
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
    });

    assert.equal(graph.needsMix, true);
    assert.ok(graph.filters.some((f) => f.includes("atrim=start=8.5:duration=1.2")));
    assert.ok(graph.filters.some((f) => f.includes("asetpts=PTS-STARTPTS")));
    assert.ok(graph.filters.some((f) => f.includes("adelay=5000|5000")));
    assert.ok(graph.filters.some((f) => f.includes("amix=inputs=2")));
  });

  it("resolveSfxPlanEntries resolves audio_event from context.clips", () => {
    const clipPath = "/tmp/clip01.MOV";
    const originalExists = fs.existsSync;
    fs.existsSync = (p) => (p === clipPath ? true : originalExists(p));

    try {
      const { sfxEntries, warnings } = resolveSfxPlanEntries(
        [{
          sfxId: "evt_clip01_8500",
          source: "audio_event",
          clipId: "clip01",
          anchorTimeSec: 8.5,
          outputStartSec: 5,
          outputEndSec: 6.2,
          volumeDb: -6,
          label: "laughter",
        }],
        { clips: { clip01: { sourcePath: clipPath } } },
        null,
      );

      assert.equal(warnings.length, 0);
      assert.equal(sfxEntries.length, 1);
      assert.equal(sfxEntries[0].sourcePath, clipPath);
      assert.ok(Math.abs(sfxEntries[0].durationSec - 1.2) < 0.001);
    } finally {
      fs.existsSync = originalExists;
    }
  });

  it("resolveSfxPlanEntries warns when audio_event clip source missing", () => {
    const { sfxEntries, warnings } = resolveSfxPlanEntries(
      [{
        sfxId: "evt_clip01_8500",
        source: "audio_event",
        clipId: "clip01",
        anchorTimeSec: 8.5,
        outputStartSec: 5,
        outputEndSec: 6.2,
        volumeDb: -6,
        label: "laughter",
      }],
      { clips: {} },
      null,
    );

    assert.equal(sfxEntries.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, "SFX_UNRESOLVED");
    assert.equal(warnings[0].sfxId, "evt_clip01_8500");
  });

  it("buildMusicBedMomentVolumeFilter emits between(t) swell boost", () => {
    const filter = buildMusicBedMomentVolumeFilter("[music_base]", "[music]", {
      techniqueId: "music_swell",
      outputStartSec: 5,
      outputEndSec: 8,
      params: { gainDb: 3 },
    });
    assert.ok(filter.includes("volume=enable='between(t\\,5\\,8)'"));
    assert.ok(filter.includes("volume=1.412"));
    assert.ok(filter.startsWith("[music_base]"));
    assert.ok(filter.endsWith("[music]"));
  });

  it("buildMusicBedMomentVolumeFilter emits between(t) drop duck with default gainDb", () => {
    const filter = buildMusicBedMomentVolumeFilter("[music]", "[ducked]", {
      techniqueId: "music_drop",
      outputStartSec: 2,
      outputEndSec: 10,
      params: {},
    });
    assert.ok(filter.includes("volume=enable='between(t\\,2\\,10)'"));
    assert.ok(filter.includes("volume=0.501"));
  });

  it("buildMusicBedMomentVolumeFilter uses params.durationSec for window end", () => {
    const filter = buildMusicBedMomentVolumeFilter("[music_base]", "[music]", {
      techniqueId: "music_swell",
      outputStartSec: 1,
      outputEndSec: 99,
      params: { durationSec: 4, gainDb: 6 },
    });
    assert.ok(filter.includes("between(t\\,1\\,5)"));
    assert.ok(filter.includes("volume=1.995"));
  });

  it("resolveMusicBedMoments keeps only music_swell and music_drop", () => {
    const moments = resolveMusicBedMoments([
      { techniqueId: "music_swell", outputStartSec: 0, outputEndSec: 3 },
      { techniqueId: "music_drop", outputStartSec: 4, outputEndSec: 8 },
      { techniqueId: "silence_beat", outputStartSec: 1, outputEndSec: 2 },
      { techniqueId: "zoom_punch_in", outputStartSec: 0, outputEndSec: 1 },
    ]);
    assert.equal(moments.length, 2);
    assert.deepEqual(moments.map((m) => m.techniqueId), ["music_swell", "music_drop"]);
  });

  it("hasAudioMixMoments is true for voice and music bed audio techniques", () => {
    assert.equal(hasAudioMixMoments([]), false);
    assert.equal(hasAudioMixMoments([{ techniqueId: "zoom_punch_in" }]), false);
    assert.equal(hasAudioMixMoments([{ techniqueId: "silence_beat" }]), true);
    assert.equal(hasAudioMixMoments([{ techniqueId: "voice_pitch_shift" }]), true);
    assert.equal(hasAudioMixMoments([{ techniqueId: "music_swell" }]), true);
    assert.equal(hasAudioMixMoments([{ techniqueId: "music_drop" }]), true);
  });

  it("buildVoiceMomentVolumeFilter hard mutes voice when volumeFactor is 0", () => {
    const filter = buildVoiceMomentVolumeFilter("[voice_base]", "[voice]", {
      techniqueId: "silence_beat",
      outputStartSec: 4,
      outputEndSec: 4.8,
      params: { durationSec: 0.8, volumeFactor: 0 },
    });
    assert.ok(filter.includes("between(t\\,4\\,4.8)"));
    assert.ok(filter.includes("volume=0"));
  });

  it("resolveVoiceAudioMoments keeps silence_beat and voice_pitch_shift", () => {
    const moments = resolveVoiceAudioMoments([
      { techniqueId: "music_swell", outputStartSec: 0, outputEndSec: 3 },
      { techniqueId: "silence_beat", outputStartSec: 1, outputEndSec: 2 },
      { techniqueId: "voice_pitch_shift", outputStartSec: 3, outputEndSec: 4 },
      { techniqueId: "silence_beat", outputStartSec: 5, outputEndSec: 6 },
      { techniqueId: "zoom_punch_in", outputStartSec: 0, outputEndSec: 1 },
    ]);
    assert.equal(moments.length, 3);
    assert.deepEqual(
      moments.map((m) => m.techniqueId),
      ["silence_beat", "voice_pitch_shift", "silence_beat"],
    );
  });

  it("computePitchShiftSampleRate scales by semitones", () => {
    assert.equal(computePitchShiftSampleRate(0), 44100);
    assert.equal(computePitchShiftSampleRate(12), 88200);
    assert.equal(computePitchShiftSampleRate(-12), 22050);
    assert.equal(computePitchShiftSampleRate(4), Math.round(44100 * (2 ** (4 / 12))));
  });

  it("buildVoicePitchShiftFilter emits asetrate/aresample split-mix chain", () => {
    const filters = buildVoicePitchShiftFilter("[voice_base]", "[voice]", {
      techniqueId: "voice_pitch_shift",
      outputStartSec: 2,
      outputEndSec: 99,
      params: { semitones: 4, durationSec: 1.2 },
    }, { id: 0 });

    assert.equal(filters.length, 5);
    assert.ok(filters[0].includes("asplit=2"));
    const rate = computePitchShiftSampleRate(4);
    assert.ok(filters[1].includes(`asetrate=${rate},aresample=44100`));
    assert.ok(filters[2].includes("between(t\\,2\\,3.2)"));
    assert.ok(filters[3].includes("between(t\\,2\\,3.2)"));
    assert.ok(filters[4].includes("amix=inputs=2"));
    assert.ok(filters[4].endsWith("[voice]"));
  });

  it("buildAudioMixFilterGraph chains voice_pitch_shift after voice loudnorm", () => {
    const graph = buildAudioMixFilterGraph({
      plan: { voiceTargetLufs: -16 },
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
      voiceAudioMoments: [{
        techniqueId: "voice_pitch_shift",
        outputStartSec: 5,
        outputEndSec: 6,
        params: { semitones: -4, durationSec: 1 },
      }],
    });

    assert.equal(graph.needsMix, true);
    assert.equal(graph.voiceOnly, true);
    const loudnormIdx = graph.filters.findIndex((f) => f.includes("loudnorm"));
    const pitchIdx = graph.filters.findIndex((f) => f.includes("asetrate="));
    assert.ok(loudnormIdx < pitchIdx, "pitch shift should follow loudnorm");
    const rate = computePitchShiftSampleRate(-4);
    assert.ok(graph.filters.some((f) => f.includes(`asetrate=${rate}`)));
  });

  it("buildVoiceMomentVolumeFilter emits between(t) dip with default volumeFactor", () => {
    const filter = buildVoiceMomentVolumeFilter("[voice_base]", "[voice]", {
      techniqueId: "silence_beat",
      outputStartSec: 3,
      outputEndSec: 4,
      params: {},
    });
    assert.ok(filter.includes("volume=enable='between(t\\,3\\,4)'"));
    assert.ok(filter.includes("volume=0.3"));
    assert.ok(filter.startsWith("[voice_base]"));
    assert.ok(filter.endsWith("[voice]"));
  });

  it("buildVoiceMomentVolumeFilter uses params.durationSec for window end", () => {
    const filter = buildVoiceMomentVolumeFilter("[voice_base]", "[voice]", {
      techniqueId: "silence_beat",
      outputStartSec: 2,
      outputEndSec: 99,
      params: { durationSec: 0.8, volumeFactor: 0.15 },
    });
    assert.ok(filter.includes("between(t\\,2\\,2.8)"));
    assert.ok(filter.includes("volume=0.15"));
  });

  it("buildAudioMixFilterGraph chains silence_beat dip after voice loudnorm", () => {
    const graph = buildAudioMixFilterGraph({
      plan: { voiceTargetLufs: -16 },
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
      voiceAudioMoments: [{
        techniqueId: "silence_beat",
        outputStartSec: 1,
        outputEndSec: 2,
        params: { durationSec: 0.8 },
      }],
    });

    assert.equal(graph.needsMix, true);
    assert.equal(graph.voiceOnly, true);
    assert.ok(graph.filters[0].includes("[voice_base]"));
    const dipFilter = graph.filters.find((f) => f.includes("between(t\\,1\\,1.8)"));
    assert.ok(dipFilter, "expected silence_beat volume dip on voice");
    assert.ok(dipFilter.includes("volume=0.3"));
    const loudnormIdx = graph.filters.findIndex((f) => f.includes("loudnorm"));
    const dipIdx = graph.filters.findIndex((f) => f.includes("between(t\\,1\\,1.8)"));
    assert.ok(loudnormIdx < dipIdx, "voice dip should follow loudnorm");
  });

  it("buildAudioMixFilterGraph chains music bed automation before ducking", () => {
    const graph = buildAudioMixFilterGraph({
      plan: { musicBed: { volumeDb: -18, duckingDb: -12 } },
      mixSegment: { duckUnderVoice: true },
      bedPath: "/tmp/bed.mp3",
      musicBedMoments: [{
        techniqueId: "music_swell",
        outputStartSec: 5,
        outputEndSec: 8,
        params: { gainDb: 3 },
      }],
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
    });

    const swellFilter = graph.filters.find((f) => f.includes("between(t\\,5\\,8)"));
    assert.ok(swellFilter, "expected swell volume automation on bed");
    assert.ok(graph.filters.some((f) => f.includes("[music_base]")));
    assert.ok(graph.filters.some((f) => f.includes("sidechaincompress")));
    const baseIdx = graph.filters.findIndex((f) => f.includes("[music_base]"));
    const scIdx = graph.filters.findIndex((f) => f.includes("sidechaincompress"));
    assert.ok(baseIdx < scIdx, "bed automation should precede sidechain ducking");
  });

  it("buildAudioMixFilterGraph uses amix normalize=0 and dropout_transition=0", () => {
    const graph = buildAudioMixFilterGraph({
      plan: { musicBed: { volumeDb: -18, duckingDb: -12 } },
      mixSegment: { duckUnderVoice: true },
      bedPath: "/tmp/bed.mp3",
      voiceLoudnormFilter: "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true",
    });

    const amix = graph.filters.find((f) => f.includes("amix=inputs="));
    assert.ok(amix?.includes("normalize=0"));
    assert.ok(amix?.includes("dropout_transition=0"));
    assert.ok(!amix?.includes("dropout_transition=2"));
  });

  it("shouldLoopMusicBed loops when bed is shorter than musicOutSec window", () => {
    assert.equal(shouldLoopMusicBed({
      bedDurationSec: 60,
      musicInSec: 0,
      musicOutSec: 120,
    }), true);
    assert.equal(shouldLoopMusicBed({
      bedDurationSec: 120,
      musicInSec: 0,
      musicOutSec: 120,
    }), false);
    assert.equal(shouldLoopMusicBed({
      bedDurationSec: 130,
      musicInSec: 10,
      musicOutSec: 120,
    }), false);
  });

  it("buildMusicBedInputArgs adds stream_loop when loop is true", () => {
    assert.deepEqual(
      buildMusicBedInputArgs("/tmp/bed.mp3", { musicInSec: 5, loop: true }),
      ["-stream_loop", "-1", "-ss", "5", "-i", "/tmp/bed.mp3"],
    );
    assert.deepEqual(
      buildMusicBedInputArgs("/tmp/bed.mp3"),
      ["-i", "/tmp/bed.mp3"],
    );
  });

  it("resolveMusicBedRequiredSec returns musicOutSec minus musicInSec", () => {
    assert.equal(resolveMusicBedRequiredSec({ musicInSec: 5, musicOutSec: 125 }), 120);
    assert.equal(resolveMusicBedRequiredSec({ musicOutSec: 90 }), 90);
    assert.equal(resolveMusicBedRequiredSec({}), null);
  });

  it("applyAudioMix builds filter_complex with two-pass loudnorm on voice", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-audio-mix-"));
    const inputPath = path.join(tmpDir, "input.mp4");
    const outputPath = path.join(tmpDir, "output.mp4");
    const { ffmpeg } = resolveFfmpegBins();

    const gen = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f", "lavfi",
        "-i", "color=c=blue:s=160x120:d=1",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=1",
        "-t", "1",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-shortest",
        inputPath,
      ],
      { encoding: "utf8" },
    );
    if (gen.status !== 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      t.skip("ffmpeg lavfi unavailable for test input generation");
    }

    let capturedFilterComplex = null;
    const measurement = {
      integratedLufs: -20.5,
      truePeakDb: -3.2,
      lra: 8.1,
      threshold: -31.0,
      targetOffset: 4.5,
    };
    const expectedLoudnorm = buildLoudnormFilter(measurement, { targetLufs: -16 });

    try {
      const result = await applyAudioMix(inputPath, outputPath, {
        recipe: {
          audioMixPlan: { voiceTargetLufs: -16 },
          sfxPlan: [],
        },
        output: { outputId: "horizontal_main" },
        context: {},
        encodeProfile: resolveEncodeProfile("draft"),
        measureLoudnessFn: async () => measurement,
        runFfmpegFn: async (args) => {
          const idx = args.indexOf("-filter_complex");
          capturedFilterComplex = idx >= 0 ? args[idx + 1] : null;
        },
      });

      assert.equal(result.applied, true);
      assert.equal(result.outputPath, outputPath);

      assert.ok(capturedFilterComplex, "expected -filter_complex in ffmpeg args");
      assert.ok(capturedFilterComplex.includes(expectedLoudnorm));
      assert.ok(capturedFilterComplex.includes("[voice]"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("applyAudioMix adds stream_loop when bed is shorter than mix window", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-audio-mix-loop-"));
    const inputPath = path.join(tmpDir, "input.mp4");
    const outputPath = path.join(tmpDir, "output.mp4");
    const bedPath = path.join(tmpDir, "bed.mp3");
    const { ffmpeg } = resolveFfmpegBins();

    const genVideo = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f", "lavfi",
        "-i", "color=c=blue:s=160x120:d=2",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=2",
        "-t", "2",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-shortest",
        inputPath,
      ],
      { encoding: "utf8" },
    );
    const genBed = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f", "lavfi",
        "-i", "sine=frequency=220:duration=1",
        "-c:a", "libmp3lame",
        bedPath,
      ],
      { encoding: "utf8" },
    );
    if (genVideo.status !== 0 || genBed.status !== 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      t.skip("ffmpeg lavfi unavailable for test input generation");
    }

    let capturedArgs = null;

    try {
      await applyAudioMix(inputPath, outputPath, {
        recipe: {
          audioMixPlan: {
            voiceTargetLufs: -16,
            musicBed: { volumeDb: -18, duckingDb: -12 },
            segments: [{
              outputId: "short_9x16",
              musicInSec: 0,
              musicOutSec: 5,
              duckUnderVoice: true,
            }],
          },
        },
        output: { outputId: "short_9x16" },
        context: {
          musicBed: {
            trackFilePath: bedPath,
            durationSec: 1,
          },
        },
        encodeProfile: resolveEncodeProfile("draft"),
        measureLoudnessFn: async () => ({ integratedLufs: -20 }),
        runFfmpegFn: async (args) => {
          capturedArgs = args;
        },
      });

      const loopIdx = capturedArgs.indexOf("-stream_loop");
      assert.ok(loopIdx >= 0, "expected -stream_loop when bed shorter than musicOutSec");
      assert.equal(capturedArgs[loopIdx + 1], "-1");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("applyAudioMix includes music swell filter when creativeMoments and bed present", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-audio-mix-swell-"));
    const inputPath = path.join(tmpDir, "input.mp4");
    const outputPath = path.join(tmpDir, "output.mp4");
    const bedPath = path.join(tmpDir, "bed.mp3");
    const { ffmpeg } = resolveFfmpegBins();

    const genVideo = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f", "lavfi",
        "-i", "color=c=blue:s=160x120:d=2",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=2",
        "-t", "2",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-shortest",
        inputPath,
      ],
      { encoding: "utf8" },
    );
    const genBed = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f", "lavfi",
        "-i", "sine=frequency=220:duration=5",
        "-c:a", "libmp3lame",
        bedPath,
      ],
      { encoding: "utf8" },
    );
    if (genVideo.status !== 0 || genBed.status !== 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      t.skip("ffmpeg lavfi unavailable for test input generation");
    }

    let capturedFilterComplex = null;

    try {
      const result = await applyAudioMix(inputPath, outputPath, {
        recipe: {
          audioMixPlan: {
            voiceTargetLufs: -16,
            musicBed: { volumeDb: -18, duckingDb: -12 },
            segments: [{ outputId: "short_9x16", musicInSec: 0, duckUnderVoice: true }],
          },
        },
        output: { outputId: "short_9x16" },
        context: { musicBed: { trackFilePath: bedPath } },
        creativeMoments: [{
          techniqueId: "music_swell",
          outputStartSec: 0.5,
          outputEndSec: 1.5,
          params: { gainDb: 3 },
        }],
        encodeProfile: resolveEncodeProfile("draft"),
        measureLoudnessFn: async () => ({ integratedLufs: -20 }),
        runFfmpegFn: async (args) => {
          const idx = args.indexOf("-filter_complex");
          capturedFilterComplex = idx >= 0 ? args[idx + 1] : null;
        },
      });

      assert.equal(result.applied, true);
      assert.equal(result.audioTechniquesApplied, true);
      assert.deepEqual(result.appliedAudioTechniques, ["music_swell"]);
      assert.ok(capturedFilterComplex?.includes("between(t\\,0.5\\,1.5)"));
      assert.ok(capturedFilterComplex?.includes("[music_base]"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("applyAudioMix includes silence_beat hard mute without audioMixPlan", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-audio-mix-hard-mute-"));
    const inputPath = path.join(tmpDir, "input.mp4");
    const outputPath = path.join(tmpDir, "output.mp4");
    const { ffmpeg } = resolveFfmpegBins();

    const gen = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f", "lavfi",
        "-i", "color=c=blue:s=160x120:d=2",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=2",
        "-t", "2",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-shortest",
        inputPath,
      ],
      { encoding: "utf8" },
    );
    if (gen.status !== 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      t.skip("ffmpeg lavfi unavailable for test input generation");
    }

    let capturedFilterComplex = null;

    try {
      const result = await applyAudioMix(inputPath, outputPath, {
        recipe: { sfxPlan: [] },
        output: { outputId: "short_9x16" },
        context: {},
        creativeMoments: [{
          techniqueId: "silence_beat",
          outputStartSec: 0.5,
          outputEndSec: 1.3,
          params: { durationSec: 0.8, volumeFactor: 0 },
        }],
        encodeProfile: resolveEncodeProfile("draft"),
        runFfmpegFn: async (args) => {
          const idx = args.indexOf("-filter_complex");
          capturedFilterComplex = idx >= 0 ? args[idx + 1] : null;
        },
      });

      assert.equal(result.applied, true);
      assert.equal(result.audioTechniquesApplied, true);
      assert.deepEqual(result.appliedAudioTechniques, ["silence_beat"]);
      assert.ok(capturedFilterComplex?.includes("volume=0"));
      assert.ok(capturedFilterComplex?.includes("between(t\\,0.5\\,1.3)"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("applyAudioMix includes silence_beat voice dip when creativeMoments present", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-audio-mix-silence-"));
    const inputPath = path.join(tmpDir, "input.mp4");
    const outputPath = path.join(tmpDir, "output.mp4");
    const { ffmpeg } = resolveFfmpegBins();

    const gen = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f", "lavfi",
        "-i", "color=c=blue:s=160x120:d=2",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=2",
        "-t", "2",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-shortest",
        inputPath,
      ],
      { encoding: "utf8" },
    );
    if (gen.status !== 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      t.skip("ffmpeg lavfi unavailable for test input generation");
    }

    let capturedFilterComplex = null;

    try {
      const result = await applyAudioMix(inputPath, outputPath, {
        recipe: {
          audioMixPlan: { voiceTargetLufs: -16 },
        },
        output: { outputId: "horizontal_main" },
        context: {},
        creativeMoments: [{
          techniqueId: "silence_beat",
          outputStartSec: 0.5,
          outputEndSec: 1.3,
          params: { durationSec: 0.8 },
        }],
        encodeProfile: resolveEncodeProfile("draft"),
        measureLoudnessFn: async () => ({ integratedLufs: -20 }),
        runFfmpegFn: async (args) => {
          const idx = args.indexOf("-filter_complex");
          capturedFilterComplex = idx >= 0 ? args[idx + 1] : null;
        },
      });

      assert.equal(result.applied, true);
      assert.equal(result.audioTechniquesApplied, true);
      assert.deepEqual(result.appliedAudioTechniques, ["silence_beat"]);
      assert.ok(capturedFilterComplex?.includes("between(t\\,0.5\\,1.3)"));
      assert.ok(capturedFilterComplex?.includes("[voice_base]"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
