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
  resolveMusicBedMoments,
  resolveVoiceAudioMoments,
  resolveSfxPath,
  resolveSfxPlanEntries,
  applyAudioMix,
} from "./audio-mix.js";
import { resolveFfmpegBins } from "../lib/ffmpeg-bin.js";
import { resolveEncodeProfile } from "./render-config.js";

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

  it("buildAudioMixFilterGraph overlays sfxPlan library entries via resolveSfxPath", () => {
    const whooshPath = resolveSfxPath("whoosh");
    assert.ok(whooshPath, "expected assets/sfx/whoosh.wav");
    assert.equal(fs.existsSync(whooshPath), true);

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

  it("resolveVoiceAudioMoments keeps only silence_beat", () => {
    const moments = resolveVoiceAudioMoments([
      { techniqueId: "music_swell", outputStartSec: 0, outputEndSec: 3 },
      { techniqueId: "silence_beat", outputStartSec: 1, outputEndSec: 2 },
      { techniqueId: "silence_beat", outputStartSec: 5, outputEndSec: 6 },
      { techniqueId: "zoom_punch_in", outputStartSec: 0, outputEndSec: 1 },
    ]);
    assert.equal(moments.length, 2);
    assert.deepEqual(moments.map((m) => m.techniqueId), ["silence_beat", "silence_beat"]);
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
