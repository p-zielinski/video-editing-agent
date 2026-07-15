import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateArtisticEditingGrammar,
  validateColorCreativeMoments,
  validateCreativeMoments,
} from "../../src/validators/creative-moments.js";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";

function recipeWith(moments) {
  return {
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      timeline: [
        {
          segmentId: "s1",
          outputStartSec: 0,
          outputEndSec: 30,
          videoInSec: 0,
          videoOutSec: 30,
        },
        {
          segmentId: "s2",
          outputStartSec: 30,
          outputEndSec: 60,
          videoInSec: 30,
          videoOutSec: 60,
        },
      ],
    }],
    creativeMoments: moments,
  };
}

describe("validateArtisticEditingGrammar", () => {
  it("warns when an artistic technique has no narrative intent", () => {
    const issues = validateArtisticEditingGrammar(recipeWith([{
      momentId: "frame_1",
      techniqueId: "cinematic_frame",
      outputId: "main_16x9",
      outputStartSec: 5,
      outputEndSec: 12,
      reason: "ładny efekt",
    }]));

    assert.ok(issues.some((issue) => issue.code === "V21-16"));
  });

  it("accepts a motivated slow push ending at a cut", () => {
    const issues = validateArtisticEditingGrammar(recipeWith([{
      momentId: "push_1",
      techniqueId: "zoom_slow_push",
      outputId: "main_16x9",
      outputStartSec: 18,
      outputEndSec: 30,
      narrativeIntent: "tension",
      reason: "Powolne przybliżenie buduje napięcie przed revealem na cięciu.",
    }]));

    assert.equal(issues.some((issue) => issue.code === "V21-16"), false);
    assert.equal(issues.some((issue) => issue.code === "V21-18"), false);
  });

  it("warns when a slow push ends away from a cut and would snap back", () => {
    const issues = validateArtisticEditingGrammar(recipeWith([{
      momentId: "push_1",
      techniqueId: "zoom_slow_push",
      outputId: "main_16x9",
      outputStartSec: 5,
      outputEndSec: 15,
      narrativeIntent: "tension",
      reason: "Buduje napięcie.",
    }]));

    assert.ok(issues.some((issue) => issue.code === "V21-18"));
  });

  it("warns about excessive strong stylization in a 30 second window", () => {
    const issues = validateArtisticEditingGrammar(recipeWith([
      {
        momentId: "frame_1",
        techniqueId: "cinematic_frame",
        outputId: "main_16x9",
        outputStartSec: 2,
        outputEndSec: 8,
        narrativeIntent: "isolation",
        reason: "Izoluje bohatera.",
      },
      {
        momentId: "slide_1",
        techniqueId: "slide_left",
        outputId: "main_16x9",
        outputStartSec: 10,
        outputEndSec: 10.5,
        narrativeIntent: "transition",
        reason: "Przejście do kolejnego etapu.",
      },
      {
        momentId: "dip_1",
        techniqueId: "dip_to_black",
        outputId: "main_16x9",
        outputStartSec: 20,
        outputEndSec: 20.6,
        narrativeIntent: "passage_of_time",
        reason: "Skok w czasie.",
      },
    ]));

    assert.ok(issues.some((issue) => issue.code === "V21-17"));
  });

  it("warns when boundary slide is not aligned to a segment join", () => {
    const issues = validateArtisticEditingGrammar(recipeWith([{
      momentId: "slide_1",
      techniqueId: "slide_left",
      outputId: "main_16x9",
      outputStartSec: 14,
      outputEndSec: 14.5,
      narrativeIntent: "transition",
      reason: "Zmiana lokacji.",
    }]));

    assert.ok(issues.some((issue) => issue.code === "V21-19"));
  });

  it("enforces catalog maxDurationSec for cinematic frame", () => {
    const recipe = recipeWith([{
      momentId: "frame_1",
      techniqueId: "cinematic_frame",
      outputId: "main_16x9",
      outputStartSec: 1,
      outputEndSec: 25,
      narrativeIntent: "memory",
      reason: "Oddziela wspomnienie od teraźniejszości.",
    }]);
    const catalog = loadTechniqueCatalog({
      pack: "youtube_vlog_2026",
      platforms: ["youtube"],
    });

    const issues = validateCreativeMoments(recipe, catalog, null);

    assert.ok(
      issues.some(
        (issue) => issue.code === "V21-02" && issue.message.includes("maxDurationSec"),
      ),
    );
  });
});

describe("validateColorCreativeMoments", () => {
  const catalog = loadTechniqueCatalog({ pack: "youtube_vlog_2026" });

  it("accepts motivated color desaturate with adequate narrativeIntent", () => {
    const issues = validateColorCreativeMoments(recipeWith([{
      momentId: "color_mem",
      techniqueId: "color_desaturate",
      outputId: "main_16x9",
      outputStartSec: 8,
      outputEndSec: 12,
      narrativeIntent: "memory",
      reason: "Krótki flashback przed powrotem do teraźniejszości.",
    }]), catalog);

    assert.equal(issues.length, 0);
  });

  it("accepts touching color windows on the same output", () => {
    const issues = validateColorCreativeMoments(recipeWith([
      {
        momentId: "color_a",
        techniqueId: "color_desaturate",
        outputId: "main_16x9",
        outputStartSec: 5,
        outputEndSec: 8,
        narrativeIntent: "isolation",
        reason: "Izolacja bohatera.",
      },
      {
        momentId: "color_b",
        techniqueId: "color_saturation_boost",
        outputId: "main_16x9",
        outputStartSec: 8,
        outputEndSec: 10,
        narrativeIntent: "reveal",
        reason: "Powrót pełnego koloru na reveal.",
      },
    ]), catalog);

    assert.equal(issues.some((issue) => issue.code === "V21-20"), false);
  });
});
