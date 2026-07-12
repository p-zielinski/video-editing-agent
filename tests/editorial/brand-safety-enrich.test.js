import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRecipeBrandSafetyText,
  findRecipeBrandSafetyViolations,
} from "../../src/editorial/brand-safety-enrich.js";

describe("enrichRecipeBrandSafetyText", () => {
  it("sanitizes titles, synopses, overlays, creative text and closure text", () => {
    const recipe = {
      batchContext: { brandSafety: { enabled: true } },
      shortsOutroBracket: { enabled: true, text: "Morderca uciekł" },
      creativeMoments: [{
        momentId: "m1",
        params: { text: "Kurwa, patrz" },
      }],
      outputs: [{
        outputId: "short",
        title: "Pedofil zatrzymany",
        synopsis: "To jest kurwa historia",
        timeline: [{
          textOverlays: [{ overlayId: "o1", text: "Morderca wraca" }],
        }],
      }],
    };

    const changed = enrichRecipeBrandSafetyText(recipe);

    assert.ok(changed >= 5);
    assert.equal(recipe.outputs[0].title, "p*****l zatrzymany");
    assert.equal(recipe.outputs[0].synopsis, "To jest k***a historia");
    assert.equal(recipe.outputs[0].timeline[0].textOverlays[0].text, "m******a wraca");
    assert.equal(recipe.creativeMoments[0].params.text, "k***a, patrz");
    assert.equal(recipe.shortsOutroBracket.text, "m******a uciekł");
    assert.deepEqual(findRecipeBrandSafetyViolations(recipe), []);
  });

  it("does not alter neutral protected identity references", () => {
    const recipe = {
      outputs: [{
        outputId: "main",
        title: "Rozmowa z Żydem o historii",
        timeline: [],
      }],
    };

    assert.equal(enrichRecipeBrandSafetyText(recipe), 0);
    assert.equal(recipe.outputs[0].title, "Rozmowa z Żydem o historii");
  });
});
