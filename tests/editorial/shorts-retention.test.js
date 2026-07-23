import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";
import {
  buildRetentionBeatAnchors,
  buildRetentionTechniqueRotation,
  computeRetentionBeatTargets,
  computeScaledMinRetentionBeats,
  DEFAULT_SHORTS_RETENTION_PROFILE,
  DEFAULT_VLOG_RETENTION_PROFILE,
  formatRetentionGrammarForPrompt,
  hasShortFormatRequired,
  hasVlogFormatRequired,
  isRetentionBeatMoment,
  mapSourceTimeToOutputSec,
  mergeShortsRetentionProfile,
  mergeVlogRetentionProfile,
  parseRetentionFromContext,
  resolveMainOutputDurationSec,
  resolveShortOutputDurationSec,
  shouldEnableShortsRetention,
  shouldEnableVlogRetention,
  suggestRetentionMoments,
  VLOG_RETENTION_TECHNIQUE_ROTATION,
} from "../../src/editorial/shorts-retention.js";

describe("shorts-retention editorial", () => {
  it("parseRetentionFromContext reads shorts: retention", () => {
    const parsed = parseRetentionFromContext("montaż shortów, shorts: retention");
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.techniquePack, "shorts_retention_2026");
  });

  it("parseRetentionFromContext reads shorts: energy high without retention pack", () => {
    const parsed = parseRetentionFromContext("shorts: energy high");
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.techniquePack, undefined);
  });

  describe("shouldEnableShortsRetention gating matrix", () => {
    it("disabled by default without signals", () => {
      assert.equal(
        shouldEnableShortsRetention({
          outputs: [{ outputKind: "main" }],
          requiredFormats: ["16:9"],
          creativityProfile: { level: "balanced" },
        }),
        false,
      );
    });

    it("enabled for short output", () => {
      assert.equal(
        shouldEnableShortsRetention({ outputs: [{ outputKind: "short" }] }),
        true,
      );
    });

    it("enabled when 9:16 required without 16:9", () => {
      assert.equal(
        shouldEnableShortsRetention({ requiredFormats: ["9:16"] }),
        true,
      );
    });

    it("enabled when both 16:9 and 9:16 required (dual format)", () => {
      assert.equal(
        shouldEnableShortsRetention({ requiredFormats: ["16:9", "9:16"] }),
        true,
      );
    });

    it("enabled for creativity level shorts", () => {
      assert.equal(
        shouldEnableShortsRetention({ creativityProfile: { level: "shorts" } }),
        true,
      );
    });

    it("enabled for shorts: retention context", () => {
      assert.equal(
        shouldEnableShortsRetention({ userContext: "shorts: retention" }),
        true,
      );
    });

    it("enabled for shorts: energy high context", () => {
      assert.equal(
        shouldEnableShortsRetention({ userContext: "shorts: energy high" }),
        true,
      );
    });

    it("explicit enabled: true forces on", () => {
      assert.equal(
        shouldEnableShortsRetention({
          outputs: [{ outputKind: "main" }],
          shortsRetentionProfile: { enabled: true },
        }),
        true,
      );
    });

    it("explicit enabled: false forces off", () => {
      assert.equal(
        shouldEnableShortsRetention({
          outputs: [{ outputKind: "short" }],
          shortsRetentionProfile: { enabled: false },
        }),
        false,
      );
    });
  });

  it("mergeShortsRetentionProfile does not poison enable from default true", () => {
    const profile = mergeShortsRetentionProfile({}, {
      outputs: [{ outputKind: "main" }],
      requiredFormats: ["16:9"],
      creativityProfile: { level: "balanced" },
    });
    assert.equal(profile.enabled, false);
  });

  it("mergeShortsRetentionProfile merges pack retentionDefaults when enabled", () => {
    const catalog = loadTechniqueCatalog({ pack: "shorts_retention_2026" });
    const profile = mergeShortsRetentionProfile(
      {},
      {
        packRetentionDefaults: catalog.pack.retentionDefaults,
        outputs: [{ outputKind: "short" }],
        creativityProfile: { level: "shorts" },
      },
    );
    assert.equal(profile.enabled, true);
    assert.equal(profile.hookWindowSec, 3);
    assert.equal(profile.retentionBeatIntervalSec, 25);
    assert.equal(profile.minRetentionBeats, 2);
    assert.equal(profile.techniquePack, "shorts_retention_2026");
  });

  it("hasShortFormatRequired detects 9:16", () => {
    assert.equal(hasShortFormatRequired(["16:9", "9:16"]), true);
    assert.equal(hasShortFormatRequired(["16:9"]), false);
  });

  it("computeScaledMinRetentionBeats scales for >30s", () => {
    const profile = { minRetentionBeats: 2, retentionBeatIntervalSec: 25 };
    assert.equal(computeScaledMinRetentionBeats(0, profile), 0);
    assert.equal(computeScaledMinRetentionBeats(25, profile), 2);
    assert.equal(computeScaledMinRetentionBeats(45, profile), 4);
    assert.equal(computeScaledMinRetentionBeats(60, profile), 4);
    assert.equal(computeScaledMinRetentionBeats(75, profile), 3);
  });

  it("computeRetentionBeatTargets emits at least minRetentionBeats for 45s short", () => {
    const profile = {
      hookWindowSec: 3,
      retentionBeatIntervalSec: 25,
      minRetentionBeats: 2,
    };
    const targets = computeRetentionBeatTargets(45, profile);
    assert.equal(targets.length, 4);
    assert.ok(targets.every((t) => t > 3 && t < 45));
  });

  it("computeRetentionBeatTargets prefers interval grid when it fits", () => {
    const profile = {
      hookWindowSec: 3,
      retentionBeatIntervalSec: 25,
      minRetentionBeats: 2,
    };
    const targets = computeRetentionBeatTargets(60, profile);
    assert.deepEqual(targets, [18, 33, 48, 48.6]);
  });

  it("resolveShortOutputDurationSec prefers short output timeline over source", () => {
    const duration = resolveShortOutputDurationSec({
      outputs: [{
        outputKind: "short",
        timeline: [{ outputEndSec: 42, videoInSec: 0, videoOutSec: 42 }],
      }],
      batchContext: { shortsMaxDurationSec: 60 },
      targetDurationSec: 600,
    });
    assert.equal(duration, 42);
  });

  it("resolveShortOutputDurationSec falls back to shortsMaxDurationSec", () => {
    const duration = resolveShortOutputDurationSec({
      outputs: [],
      batchContext: { shortsMaxDurationSec: 45 },
      targetDurationSec: 600,
    });
    assert.equal(duration, 45);
  });

  it("isRetentionBeatMoment prefers retentionRole beat over techniqueId", () => {
    assert.equal(
      isRetentionBeatMoment({ retentionRole: "beat", techniqueId: "zoom_punch_in" }),
      true,
    );
    assert.equal(
      isRetentionBeatMoment({ retentionRole: "hook", techniqueId: "pattern_interrupt" }),
      false,
    );
    assert.equal(
      isRetentionBeatMoment({ techniqueId: "pattern_interrupt" }),
      true,
    );
  });

  it("formatRetentionGrammarForPrompt returns null when disabled", () => {
    assert.equal(formatRetentionGrammarForPrompt({ enabled: false }), null);
  });

  it("formatRetentionGrammarForPrompt includes rules when enabled", () => {
    const summary = formatRetentionGrammarForPrompt(
      { enabled: true, hookWindowSec: 3, retentionBeatIntervalSec: 25, minRetentionBeats: 2 },
      [28],
    );
    assert.ok(summary.rules.length >= 4);
    assert.match(summary.rules[1], /28s/);
    assert.equal(summary.mode, "shorts");
  });

  describe("vlog retention profile", () => {
    it("DEFAULT_VLOG_RETENTION_PROFILE uses 45s interval and 8s tolerance", () => {
      assert.equal(DEFAULT_VLOG_RETENTION_PROFILE.retentionBeatIntervalSec, 45);
      assert.equal(DEFAULT_VLOG_RETENTION_PROFILE.retentionBeatToleranceSec, 8);
      assert.equal(DEFAULT_VLOG_RETENTION_PROFILE.mode, "vlog");
    });

    it("hasVlogFormatRequired detects 16:9 without short-only", () => {
      assert.equal(hasVlogFormatRequired(["16:9"]), true);
      assert.equal(hasVlogFormatRequired(["16:9", "9:16"]), true);
      assert.equal(hasVlogFormatRequired(["9:16"]), false);
    });

    it("shouldEnableVlogRetention enabled for 16:9 requiredFormats", () => {
      assert.equal(
        shouldEnableVlogRetention({ requiredFormats: ["16:9"] }),
        true,
      );
    });

    it("shouldEnableVlogRetention disabled for short-only", () => {
      assert.equal(
        shouldEnableVlogRetention({ requiredFormats: ["9:16"] }),
        false,
      );
    });

    it("shouldEnableShortsRetention enabled for dual format", () => {
      assert.equal(
        shouldEnableShortsRetention({ requiredFormats: ["16:9", "9:16"] }),
        true,
      );
    });

    it("mergeVlogRetentionProfile enables for 16:9 main", () => {
      const profile = mergeVlogRetentionProfile({}, { requiredFormats: ["16:9"] });
      assert.equal(profile.enabled, true);
      assert.equal(profile.retentionBeatIntervalSec, 45);
    });

    it("computeRetentionBeatTargets vlog mode uses 45s interval", () => {
      const targets = computeRetentionBeatTargets(180, {}, { mode: "vlog" });
      assert.ok(targets.length >= 2);
      assert.deepEqual(targets.slice(0, 3), [48, 93, 138]);
    });

    it("computeRetentionBeatTargets shorts mode uses denser interval for reels", () => {
      const targets = computeRetentionBeatTargets(60, {}, { mode: "shorts" });
      assert.deepEqual(targets, [18, 33, 48, 48.6]);
    });

    it("buildRetentionTechniqueRotation cycles vlog techniques", () => {
      const rotation = buildRetentionTechniqueRotation(5, "vlog");
      assert.deepEqual(rotation, [
        "zoom_slow_push",
        "ken_burns_light",
        "music_swell",
        "silence_beat",
        "zoom_slow_push",
      ]);
      assert.deepEqual(
        rotation.slice(0, VLOG_RETENTION_TECHNIQUE_ROTATION.length),
        VLOG_RETENTION_TECHNIQUE_ROTATION,
      );
    });

    it("formatRetentionGrammarForPrompt vlog mode prefers subtle techniques", () => {
      const rotation = buildRetentionTechniqueRotation(2, "vlog");
      const summary = formatRetentionGrammarForPrompt(
        { enabled: true, retentionBeatIntervalSec: 45, minRetentionBeats: 2, techniquePack: "youtube_vlog_2026", mode: "vlog" },
        [48, 93],
        { mode: "vlog", techniqueRotation: rotation },
      );
      assert.equal(summary.mode, "vlog");
      assert.match(summary.rules[3], /zoom_slow_push/);
      assert.match(summary.rules[3], /unikaj jump_cut/);
    });

    it("resolveMainOutputDurationSec prefers main output timeline", () => {
      const duration = resolveMainOutputDurationSec({
        outputs: [{
          outputKind: "main",
          timeline: [{ outputEndSec: 720, videoInSec: 0, videoOutSec: 720 }],
        }],
        targetDurationSec: 60,
      });
      assert.equal(duration, 720);
    });

    it("suggestRetentionMoments returns brief hints for missing beats", () => {
      const recipe = {
        outputs: [{
          outputId: "main",
          outputKind: "main",
          format: "16:9",
          timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
        }],
        creativeMoments: [],
      };
      const suggestions = suggestRetentionMoments(recipe, DEFAULT_VLOG_RETENTION_PROFILE);
      assert.ok(suggestions.length >= 2);
      assert.equal(suggestions[0].suggestedTechniqueId, "zoom_slow_push");
      assert.equal(suggestions[0].retentionRole, "beat");
    });

    it("suggestRetentionMoments empty when beat exists near target", () => {
      const recipe = {
        outputs: [{
          outputId: "main",
          outputKind: "main",
          format: "16:9",
          timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
        }],
        creativeMoments: [
          { outputId: "main", retentionRole: "beat", outputStartSec: 48, techniqueId: "zoom_slow_push" },
          { outputId: "main", retentionRole: "beat", outputStartSec: 93, techniqueId: "ken_burns_light" },
          { outputId: "main", retentionRole: "beat", outputStartSec: 138, techniqueId: "music_swell" },
        ],
      };
      const suggestions = suggestRetentionMoments(recipe, DEFAULT_VLOG_RETENTION_PROFILE);
      assert.equal(suggestions.length, 0);
    });

    it("buildRetentionBeatAnchors snaps to energyPeaks within tolerance", () => {
      const profile = { ...DEFAULT_VLOG_RETENTION_PROFILE, enabled: true };
      const audioIndex = {
        clips: [{
          clipId: "clip01",
          energyPeaks: [
            { startSec: 39, endSec: 41, rmsDb: -12 },
            { startSec: 46, endSec: 50, rmsDb: -10 },
          ],
        }],
      };
      const anchors = buildRetentionBeatAnchors(
        audioIndex,
        { L1: [], L2: [] },
        profile,
        { durationSec: 60, mode: "vlog" },
      );
      assert.ok(anchors.length >= 2);
      assert.equal(anchors[0].suggestedTechniqueId, "zoom_slow_push");
      assert.equal(anchors[0].retentionRole, "beat");
      assert.equal(anchors[0].anchorSource, "energyPeak");
      assert.equal(anchors[0].clipId, "clip01");
      assert.equal(anchors[0].outputSec, 40);
    });

    it("buildRetentionBeatAnchors snaps to L1 keyMoments via timeline words", () => {
      const profile = { ...DEFAULT_VLOG_RETENTION_PROFILE, enabled: true };
      const abstraction = {
        L1: [{ sceneId: "clip01_scene001", keyMoments: ["restauracja"] }],
        L2: [{ sceneIds: ["clip01_scene001"] }],
      };
      const timelineIndex = {
        scenes: [{
          sceneId: "clip01_scene001",
          clipId: "clip01",
          startSec: 0,
          endSec: 60,
          durationSec: 60,
        }],
        words: [{
          wordId: "clip01_w010",
          word: "restauracja",
          start: 47.2,
          end: 47.8,
          isFiller: false,
        }],
      };
      const anchors = buildRetentionBeatAnchors(
        { clips: [] },
        abstraction,
        profile,
        { timelineIndex, durationSec: 60, mode: "vlog" },
      );
      const snapped = anchors.find((a) => a.anchorSource === "l1_keyMoment");
      assert.ok(snapped);
      assert.equal(snapped.outputSec, 47.2);
      assert.equal(snapped.label, "restauracja");
    });

    it("buildRetentionBeatAnchors falls back to cadence when no nearby anchor", () => {
      const profile = { ...DEFAULT_VLOG_RETENTION_PROFILE, enabled: true };
      const anchors = buildRetentionBeatAnchors(
        { clips: [{ clipId: "clip01", energyPeaks: [{ startSec: 5, endSec: 6, rmsDb: -8 }] }] },
        { L1: [], L2: [] },
        profile,
        { durationSec: 60, mode: "vlog" },
      );
      assert.ok(anchors.some((a) => a.anchorSource === "cadence"));
    });

    it("buildRetentionBeatAnchors returns empty when profile disabled", () => {
      assert.deepEqual(
        buildRetentionBeatAnchors({ clips: [] }, {}, { enabled: false }),
        [],
      );
    });

    it("mapSourceTimeToOutputSec maps clip source time through output timeline", () => {
      const recipe = {
        outputs: [{
          outputId: "main",
          outputKind: "main",
          format: "16:9",
          timeline: [
            {
              segmentId: "s1",
              videoRef: { clipId: "clip01" },
              videoInSec: 50,
              videoOutSec: 100,
              audioInSec: 50,
              audioOutSec: 100,
              outputStartSec: 0,
            },
            {
              segmentId: "s2",
              videoRef: { clipId: "clip02" },
              videoInSec: 0,
              videoOutSec: 30,
              audioInSec: 0,
              audioOutSec: 30,
              outputStartSec: 50,
            },
          ],
        }],
      };

      assert.equal(mapSourceTimeToOutputSec(recipe, "clip01", 60), 10);
      assert.equal(mapSourceTimeToOutputSec(recipe, "clip02", 10), 60);
      assert.equal(mapSourceTimeToOutputSec(recipe, "clip01", 40), null);
    });

    it("mapSourceTimeToOutputSec falls back to source time without timeline", () => {
      assert.equal(mapSourceTimeToOutputSec({ outputs: [] }, "clip01", 42.3), 42.3);
    });

    it("buildRetentionBeatAnchors compares mapped outputSec not raw source time", () => {
      const profile = { ...DEFAULT_VLOG_RETENTION_PROFILE, enabled: true };
      const recipe = {
        outputs: [{
          outputId: "main",
          outputKind: "main",
          timeline: [{
            videoRef: { clipId: "clip01" },
            videoInSec: 50,
            videoOutSec: 200,
            audioInSec: 50,
            audioOutSec: 200,
            outputStartSec: 0,
          }],
        }],
      };
      const audioIndex = {
        clips: [{
          clipId: "clip01",
          energyPeaks: [{ startSec: 97, endSec: 99, rmsDb: -12 }],
        }],
      };

      const anchors = buildRetentionBeatAnchors(
        audioIndex,
        { L1: [], L2: [] },
        profile,
        { durationSec: 60, mode: "vlog", recipe },
      );

      const snapped = anchors.find((anchor) => anchor.anchorSource === "energyPeak");
      assert.ok(snapped);
      assert.equal(snapped.anchorTimeSec, 98);
      assert.equal(snapped.outputSec, 48);
      assert.notEqual(snapped.outputSec, snapped.anchorTimeSec);
      assert.equal(snapped.clipId, "clip01");
    });

    it("buildRetentionBeatAnchors uses short output timeline when outputKind short", () => {
      const profile = { ...DEFAULT_SHORTS_RETENTION_PROFILE, enabled: true };
      const outputs = [{
        outputId: "short",
        outputKind: "short",
        format: "9:16",
        timeline: [{
          videoRef: { clipId: "clip01" },
          videoInSec: 20,
          videoOutSec: 80,
          audioInSec: 20,
          audioOutSec: 80,
          outputStartSec: 0,
        }],
      }];
      const audioIndex = {
        clips: [{
          clipId: "clip01",
          energyPeaks: [{ startSec: 47, endSec: 49, rmsDb: -10 }],
        }],
      };

      const anchors = buildRetentionBeatAnchors(
        audioIndex,
        { L1: [], L2: [] },
        profile,
        { durationSec: 60, mode: "shorts", outputs, outputKind: "short" },
      );

      const snapped = anchors.find((anchor) => anchor.anchorSource === "energyPeak");
      assert.ok(snapped);
      assert.equal(snapped.anchorTimeSec, 48);
      assert.equal(snapped.outputSec, 28);
    });
  });
});
