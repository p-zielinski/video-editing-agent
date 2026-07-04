import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRecipeClosureCta,
  CLOSURE_CTA_OVERLAY_ID,
} from "../../src/editorial/closure-enrich.js";
import { applyDeterministicRecipeEnrichers } from "../../src/pipeline/steps/agents.js";
import { DEFAULT_RENDER_STYLE_PRESETS } from "../../src/render/style-presets.js";

const abstractionDocumentary = {
  L2: [
    { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
    { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240, narrativeRole: "climax" },
    { segmentId: "seg003", sceneIds: ["clip01_scene003"], startSec: 240, endSec: 360, narrativeRole: "resolution" },
  ],
  L3: {
    sessionSummary: "Vlog o restauracji i jedzeniu w mieście.",
  },
};

function buildMainRecipe(extra = {}) {
  return {
    version: "2.4",
    batchId: "batch1",
    batchContext: { requiredFormats: ["16:9"] },
    clipRegistry: [{ clipId: "clip01", durationSec: 360 }],
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      timeline: [{
        segmentId: "seg_body",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 360,
        audioInSec: 0,
        audioOutSec: 360,
        audioPolicy: "from_video_ref",
        cuts: [],
      }],
    }],
    ...extra,
  };
}

function collectOverlays(recipe) {
  return (recipe.outputs?.[0]?.timeline ?? []).flatMap((seg) => seg.textOverlays ?? []);
}

describe("enrichRecipeClosureCta", () => {
  it("adds enrich_cta_001 on main >= 60s when mode is internet_documentary", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: { mode: "internet_documentary" },
    });

    enrichRecipeClosureCta(recipe, { abstraction: abstractionDocumentary });

    const overlays = collectOverlays(recipe);
    assert.equal(overlays.length, 1);
    const cta = overlays[0];
    assert.equal(cta.overlayId, CLOSURE_CTA_OVERLAY_ID);
    assert.equal(cta.style, "cta");
    assert.equal(cta.role, "cta");
    assert.equal(cta.text, "Vlog o restauracji i jedzeniu w mieście.");
    assert.equal(cta.outputEndSec, 360);
    assert.equal(cta.outputStartSec, 350);
  });

  it("adds CTA when final L2 narrativeRole is resolution without documentary mode", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: { mode: "retention_vlog" },
    });

    enrichRecipeClosureCta(recipe, { abstraction: abstractionDocumentary });

    const overlays = collectOverlays(recipe);
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].overlayId, CLOSURE_CTA_OVERLAY_ID);
  });

  it("skips when duration is under 60s", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: { mode: "internet_documentary" },
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01" },
          audioRef: { clipId: "clip01" },
          videoInSec: 0,
          videoOutSec: 45,
          audioInSec: 0,
          audioOutSec: 45,
          audioPolicy: "from_video_ref",
          cuts: [],
        }],
      }],
    });

    enrichRecipeClosureCta(recipe, { abstraction: abstractionDocumentary });
    assert.equal(collectOverlays(recipe).length, 0);
  });

  it("skips when neither documentary mode nor final resolution L2", () => {
    const abstraction = {
      L2: [
        { segmentId: "seg001", startSec: 0, endSec: 360, narrativeRole: "climax" },
      ],
      L3: { sessionSummary: "Climax ending." },
    };
    const recipe = buildMainRecipe({
      narrativeProfile: { mode: "retention_vlog" },
    });

    enrichRecipeClosureCta(recipe, { abstraction });
    assert.equal(collectOverlays(recipe).length, 0);
  });

  it("skips when director already placed role cta in last 15s", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: { mode: "internet_documentary" },
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01" },
          audioRef: { clipId: "clip01" },
          videoInSec: 0,
          videoOutSec: 360,
          audioInSec: 0,
          audioOutSec: 360,
          audioPolicy: "from_video_ref",
          cuts: [],
          textOverlays: [{
            overlayId: "director_cta",
            text: "Like and subscribe",
            outputStartSec: 348,
            outputEndSec: 360,
            style: "emphasis",
            role: "cta",
          }],
        }],
      }],
    });

    enrichRecipeClosureCta(recipe, { abstraction: abstractionDocumentary });
    assert.equal(collectOverlays(recipe).length, 1);
    assert.equal(collectOverlays(recipe)[0].overlayId, "director_cta");
  });

  it("skips when final segment has high retentionIntensity", () => {
    const abstraction = {
      L2: [
        { segmentId: "seg_tension", startSec: 240, endSec: 360, narrativeRole: "tension" },
      ],
      L3: { sessionSummary: "High energy ending." },
    };
    const recipe = buildMainRecipe({
      narrativeProfile: {
        mode: "internet_documentary",
        segments: [{
          l2SegmentId: "seg_tension",
          rhythm: "fast",
          retentionIntensity: "high",
        }],
      },
    });

    enrichRecipeClosureCta(recipe, { abstraction });
    assert.equal(collectOverlays(recipe).length, 0);
  });

  it("uses default text when sessionSummary is missing", () => {
    const abstraction = {
      L2: [
        { segmentId: "seg_resolution", startSec: 0, endSec: 360, narrativeRole: "resolution" },
      ],
      L3: {},
    };
    const recipe = buildMainRecipe();

    enrichRecipeClosureCta(recipe, { abstraction });

    const overlays = collectOverlays(recipe);
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].text, "Subscribe for more");
  });

  it("is idempotent when enrich_cta_001 already exists", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: { mode: "internet_documentary" },
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01" },
          audioRef: { clipId: "clip01" },
          videoInSec: 0,
          videoOutSec: 360,
          audioInSec: 0,
          audioOutSec: 360,
          audioPolicy: "from_video_ref",
          cuts: [],
          textOverlays: [{
            overlayId: CLOSURE_CTA_OVERLAY_ID,
            text: "Subscribe for more",
            outputStartSec: 350,
            outputEndSec: 360,
            style: "cta",
            role: "cta",
          }],
        }],
      }],
    });

    enrichRecipeClosureCta(recipe, { abstraction: abstractionDocumentary });
    assert.equal(collectOverlays(recipe).length, 1);
  });
});

describe("cta style preset", () => {
  it("defines subtle bottom-third styling", () => {
    const preset = DEFAULT_RENDER_STYLE_PRESETS.overlays.cta;
    assert.ok(preset);
    assert.equal(preset.position, "bottom_center");
    assert.ok(preset.safeMarginPct >= 0.15);
    assert.ok(preset.fontSizePx < DEFAULT_RENDER_STYLE_PRESETS.overlays.hook_large.fontSizePx);
  });
});

describe("applyDeterministicRecipeEnrichers closure CTA integration", () => {
  it("adds enrich_cta_001 after payoff and before chapter cards", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: { mode: "internet_documentary" },
      vlogRetentionProfile: { enabled: true, beatIntervalSec: 45, beatToleranceSec: 8 },
      audioMixPlan: { musicBed: { trackId: "bed_01", volumeDb: -18, duckingDb: -12 } },
    });

    applyDeterministicRecipeEnrichers(recipe, {
      abstraction: abstractionDocumentary,
      timelineIndex: {
        scenes: [
          { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
          { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
          { sceneId: "clip01_scene003", clipId: "clip01", startSec: 240, endSec: 360 },
        ],
      },
      audioIndex: { clips: [{ clipId: "clip01", energyPeaks: [] }] },
      clipRegistry: [{ clipId: "clip01", durationSec: 360 }],
      batchContext: { brollStrategy: "minimal" },
    });

    const overlays = collectOverlays(recipe);
    const cta = overlays.find((overlay) => overlay.overlayId === CLOSURE_CTA_OVERLAY_ID);
    assert.ok(cta);
    assert.equal(cta.role, "cta");
  });
});
