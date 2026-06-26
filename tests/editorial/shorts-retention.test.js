import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";
import {
  computeRetentionBeatTargets,
  computeScaledMinRetentionBeats,
  formatRetentionGrammarForPrompt,
  hasShortFormatRequired,
  isRetentionBeatMoment,
  mergeShortsRetentionProfile,
  parseRetentionFromContext,
  resolveShortOutputDurationSec,
  shouldEnableShortsRetention,
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

    it("not enabled when both 16:9 and 9:16 required (default dual format)", () => {
      assert.equal(
        shouldEnableShortsRetention({ requiredFormats: ["16:9", "9:16"] }),
        false,
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
    assert.equal(computeScaledMinRetentionBeats(25, profile), 2);
    assert.equal(computeScaledMinRetentionBeats(45, profile), 2);
    assert.equal(computeScaledMinRetentionBeats(60, profile), 2);
    assert.equal(computeScaledMinRetentionBeats(75, profile), 3);
  });

  it("computeRetentionBeatTargets emits at least minRetentionBeats for 45s short", () => {
    const profile = {
      hookWindowSec: 3,
      retentionBeatIntervalSec: 25,
      minRetentionBeats: 2,
    };
    const targets = computeRetentionBeatTargets(45, profile);
    assert.equal(targets.length, 2);
    assert.ok(targets.every((t) => t > 3 && t < 45));
  });

  it("computeRetentionBeatTargets prefers interval grid when it fits", () => {
    const profile = {
      hookWindowSec: 3,
      retentionBeatIntervalSec: 25,
      minRetentionBeats: 2,
    };
    const targets = computeRetentionBeatTargets(60, profile);
    assert.deepEqual(targets, [28, 53]);
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
  });
});
