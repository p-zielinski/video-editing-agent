import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTechniqueFilter, listSupportedTechniques, buildTimedSaturationFilter, clampSaturationFactor } from "./technique-to-ffmpeg.js";

describe("technique-to-ffmpeg", () => {
  it("lists supported camera techniques", () => {
    const ids = listSupportedTechniques();
    assert.ok(ids.includes("zoom_punch_in"));
    assert.ok(ids.includes("zoom_punch_out"));
    assert.ok(ids.includes("snap_zoom"));
    assert.ok(ids.includes("dip_to_black"));
    assert.ok(ids.includes("whip_pan"));
    assert.ok(ids.includes("match_cut"));
    assert.ok(ids.includes("color_desaturate"));
    assert.ok(ids.includes("color_saturation_boost"));
  });

  it("builds scale filter for zoom_punch_out with factor < 1", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "zoom_punch_out",
        outputStartSec: 1,
        outputEndSec: 3,
        params: { factor: 0.92 },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("scale="));
    assert.ok(result.filter?.includes("0.92"));
    assert.equal(result.deferred, undefined);
  });

  it("defaults zoom_punch_out factor to 0.92", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "zoom_punch_out",
        outputStartSec: 0,
        outputEndSec: 2,
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("0.92"));
  });

  it("zoom_slow_push uses spatialRef bbox center when provided", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "zoom_slow_push",
        outputStartSec: 1,
        outputEndSec: 4,
        spatialRef: {
          clipId: "clip01",
          sceneId: "clip01_scene001",
          bbox: [0.2, 0.25, 0.35, 0.45],
          anchorType: "face",
        },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("scale="));
    assert.ok(result.filter?.includes("crop="));
    assert.ok(result.filter?.includes("0.3750"));
    assert.ok(result.filter?.includes("0.4750"));
  });

  it("builds duration-aware slow push without duplicating frames", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "zoom_slow_push",
        outputStartSec: 10,
        outputEndSec: 22,
        params: { factor: 1.08, durationSec: 12 },
      },
      { dimensions: { width: 1920, height: 1080 } },
    );

    assert.ok(result.filter?.includes("eval=frame"));
    assert.ok(result.filter?.includes("(t-10)/12"));
    assert.ok(result.filter?.includes("1.08"));
    assert.ok(!result.filter?.includes("d=125"));
  });

  it("builds rounded cinematic frame over a blurred background", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "cinematic_frame",
        outputStartSec: 12,
        outputEndSec: 20,
        params: {
          scale: 0.82,
          cornerRadiusPx: 36,
          borderWidthPx: 5,
          background: "blur",
        },
      },
      { dimensions: { width: 1920, height: 1080 } },
    );

    assert.ok(result.filter?.includes("split=3"));
    assert.ok(result.filter?.includes("boxblur="));
    assert.ok(result.filter?.includes("geq="));
    assert.ok(result.filter?.includes("pow(max(abs(X-W/2)"));
    assert.ok(result.filter?.includes("overlay="));
    assert.ok(result.filter?.includes("between(t\\,12\\,20)"));
  });

  it("builds fade out/in filter for dip_to_black", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "dip_to_black",
        outputStartSec: 10,
        outputEndSec: 10.6,
        params: { durationSec: 0.6, holdBlackSec: 0.2 },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("fade=t=out"));
    assert.ok(result.filter?.includes("fade=t=in"));
    assert.ok(result.filter?.includes("color=black"));
    assert.ok(result.filter?.includes("st=10"));
  });

  it("clamps dip_to_black duration to 0.3-0.8s", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "dip_to_black",
        outputStartSec: 5,
        outputEndSec: 5.1,
        params: { durationSec: 2.0, holdBlackSec: 0 },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("d=0.4"));
  });

  it("builds directional gblur for whip_pan with default 0.2s duration", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "whip_pan",
        outputStartSec: 4,
        outputEndSec: 4.2,
        params: { direction: "right" },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("gblur="));
    assert.ok(result.filter?.includes("sigmaX='if(between(t\\,4\\,4.2)"));
    assert.ok(result.filter?.includes("18"));
  });

  it("builds vertical whip_pan blur for up direction", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "whip_pan",
        outputStartSec: 1,
        outputEndSec: 1.2,
        params: { direction: "up", durationSec: 0.2 },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("sigmaY='if(between(t\\,1\\,1.2)"));
    assert.ok(result.filter?.includes("18"));
  });

  it("builds scale+gblur match_cut filter with motion blur and subtle scale", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "match_cut",
        outputStartSec: 10,
        outputEndSec: 10.2,
        params: { matchType: "motion" },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("scale="));
    assert.ok(result.filter?.includes("gblur="));
    assert.ok(result.filter?.includes("1.03"));
    assert.ok(result.filter?.includes("between(t\\,10\\,10.2)"));
    assert.equal(result.deferred, undefined);
  });

  it("builds softer match_cut for shape/color matchType", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "match_cut",
        outputStartSec: 5,
        outputEndSec: 5.25,
        params: { matchType: "shape" },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("1.02"));
    assert.ok(result.filter?.includes("gblur="));
  });

  it("builds scale filter for snap_zoom moment", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "snap_zoom",
        outputStartSec: 0.5,
        outputEndSec: 2,
        params: { factor: 1.12 },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("scale="));
    assert.ok(result.filter?.includes("1.12"));
  });

  it("builds scale+brightness pulse for pattern_interrupt cut_zoom (default)", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "pattern_interrupt",
        outputStartSec: 24,
        outputEndSec: 26,
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("scale="));
    assert.ok(result.filter?.includes("eq=brightness="));
    assert.ok(result.filter?.includes("between(t\\,24"));
  });

  it("builds scale-only for pattern_interrupt zoom_text", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "pattern_interrupt",
        outputStartSec: 24,
        outputEndSec: 26,
        params: { mode: "zoom_text" },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("scale="));
    assert.ok(!result.filter?.includes("eq=brightness="));
  });

  it("delegates pattern_interrupt cut_text to graphics with fallback scale+eq", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "pattern_interrupt",
        outputStartSec: 24,
        outputEndSec: 26,
        params: { mode: "cut_text" },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.equal(result.delegatesTo, "graphics");
    assert.ok(result.filter?.includes("scale="));
    assert.ok(result.filter?.includes("eq=brightness="));
  });

  it("returns deferred concat marker for crossfade and cut_on_beat at segment boundaries", () => {
    for (const techniqueId of ["crossfade", "cut_on_beat"]) {
      const result = buildTechniqueFilter(
        { techniqueId, outputStartSec: 0, outputEndSec: 1 },
        { dimensions: { width: 1920, height: 1080 } },
      );
      assert.equal(result.filter, null);
      assert.equal(result.deferred, "concat");
    }
  });

  it("builds stronger retention pulse for cut_mid_sentence by energy", () => {
    const low = buildTechniqueFilter(
      {
        techniqueId: "cut_mid_sentence",
        outputStartSec: 30,
        outputEndSec: 30.2,
        params: { energy: "low" },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    const high = buildTechniqueFilter(
      {
        techniqueId: "cut_mid_sentence",
        outputStartSec: 30,
        outputEndSec: 30.2,
        params: { energy: "high" },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(low.filter?.includes("eq=brightness="));
    assert.ok(high.filter?.includes("eq=brightness="));
    assert.ok(high.filter?.includes("0.28") || high.filter?.includes("0.25"));
    assert.equal(low.deferred, undefined);
    assert.equal(high.deferred, undefined);
  });

  it("builds brightness/contrast pulse for jump_cut at cut point", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "jump_cut",
        outputStartSec: 2.0,
        outputEndSec: 2.2,
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("eq=brightness="));
    assert.ok(result.filter?.includes("eq=contrast=") || result.filter?.includes(":contrast="));
    assert.ok(result.filter?.includes("between(t\\,2"));
    assert.equal(result.deferred, undefined);
  });

  it("builds scale+brightness filter for hook_visual_punch", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "hook_visual_punch",
        outputStartSec: 0,
        outputEndSec: 2,
        params: { intensity: "strong" },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("scale="));
    assert.ok(result.filter?.includes("1.18"));
    assert.ok(result.filter?.includes("eq=brightness="));
  });

  it("uses spatialRef bbox anchor for hook_visual_punch zoom", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "hook_visual_punch",
        outputStartSec: 0,
        outputEndSec: 2,
        spatialRef: { bbox: [0.4, 0.2, 0.5, 0.4] },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("zoompan="));
    assert.ok(result.filter?.includes("702-"));
  });

  it("delegates retention_beat to pattern_interrupt via linkedTechniqueId", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "retention_beat",
        outputStartSec: 40,
        outputEndSec: 42,
        params: { linkedTechniqueId: "pattern_interrupt" },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("scale="));
    assert.ok(result.filter?.includes("eq=brightness="));
  });

  it("builds subtle zoom+flash for retention_beat with unknown linkedTechniqueId", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "retention_beat",
        outputStartSec: 40,
        outputEndSec: 42,
        params: { linkedTechniqueId: "snap_zoom" },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("scale="));
    assert.ok(result.filter?.includes("1.06"));
    assert.ok(result.filter?.includes("eq=brightness="));
  });

  it("returns null filter for graphics delegated to overlay pass", () => {
    const result = buildTechniqueFilter(
      { techniqueId: "hook_title_overlay", outputStartSec: 0, outputEndSec: 2 },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.equal(result.filter, null);
    assert.equal(result.delegatesTo, "graphics");
  });

  it("limits ken_burns_light zoompan to outputStartSec/outputEndSec window", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "ken_burns_light",
        outputStartSec: 3,
        outputEndSec: 8,
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("zoompan="));
    assert.ok(result.filter?.includes("between(t,3,8)"));
    assert.ok(result.filter?.includes("min(zoom+0.0005,1.08)"));
  });

  it("limits reframe_follow_subject zoompan to output time window", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "reframe_follow_subject",
        outputStartSec: 2,
        outputEndSec: 5,
        spatialRef: { bbox: [0.25, 0.1, 0.5, 0.4] },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("zoompan="));
    assert.ok(result.filter?.includes("between(t,2,5)"));
    assert.ok(result.filter?.includes("270-"));
  });

  it("returns warning when reframe_follow_subject has no spatialRef", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "reframe_follow_subject",
        outputStartSec: 0,
        outputEndSec: 2,
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.equal(result.filter, null);
    assert.ok(result.warning?.includes("spatialRef"));
  });

  it("builds brightness/contrast pulse for hard_cut_energy at cut point", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "hard_cut_energy",
        outputStartSec: 4.5,
        outputEndSec: 4.7,
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("eq=brightness="));
    assert.ok(result.filter?.includes("eq=contrast=") || result.filter?.includes(":contrast="));
    assert.ok(result.filter?.includes("between(t\\,4.5"));
    assert.equal(result.deferred, undefined);
  });

  it("buildTimedSaturationFilter uses between, eval=frame and escapes commas", () => {
    const filter = buildTimedSaturationFilter({
      outputStartSec: 5,
      outputEndSec: 8,
      saturation: 0,
      inputLabel: "[0:v]",
      outputLabel: "[vout]",
    });
    assert.ok(filter.includes("eq=saturation="));
    assert.ok(filter.includes("between(t\\,5\\,8)"));
    assert.ok(filter.includes("eval=frame"));
    assert.ok(filter.includes(",1)':eval=frame"));
  });

  it("clampSaturationFactor clamps out-of-range values defensively", () => {
    assert.equal(clampSaturationFactor(-1), 0);
    assert.equal(clampSaturationFactor(5), 3);
    assert.equal(clampSaturationFactor(Number.NaN), 1);
    assert.equal(clampSaturationFactor(1.12), 1.12);
  });

  it("builds full B&W color_desaturate with default amount 1", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "color_desaturate",
        outputStartSec: 10,
        outputEndSec: 14,
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("eq=saturation="));
    assert.ok(result.filter?.includes("between(t\\,10\\,14)"));
    assert.ok(result.filter?.includes(",0\\,1)"));
    assert.ok(result.filter?.includes("eval=frame"));
  });

  it("builds partial desaturate when amount is below 1", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "color_desaturate",
        outputStartSec: 2,
        outputEndSec: 5,
        params: { amount: 0.5 },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes(",0.5\\,1)"));
  });

  it("clamps color_desaturate saturation at zero for extreme amount", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "color_desaturate",
        outputStartSec: 0,
        outputEndSec: 2,
        params: { amount: 2 },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes(",0\\,1)"));
  });

  it("builds color_saturation_boost with default boost 0.12", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "color_saturation_boost",
        outputStartSec: 20,
        outputEndSec: 23,
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes("eq=saturation="));
    assert.ok(result.filter?.includes("between(t\\,20\\,23)"));
    assert.ok(result.filter?.includes(",1.12\\,1)"));
  });

  it("builds color_saturation_boost with explicit boost param", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "color_saturation_boost",
        outputStartSec: 1,
        outputEndSec: 3,
        params: { boost: 0.2 },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes(",1.2\\,1)"));
  });

  it("clamps color_saturation_boost saturation at max for extreme boost", () => {
    const result = buildTechniqueFilter(
      {
        techniqueId: "color_saturation_boost",
        outputStartSec: 0,
        outputEndSec: 1,
        params: { boost: 5 },
      },
      { dimensions: { width: 1080, height: 1920 } },
    );
    assert.ok(result.filter?.includes(",3\\,1)"));
  });
});
