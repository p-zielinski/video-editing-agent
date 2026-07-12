import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBrandSafetyText } from "./brand-safety.js";

describe("validateBrandSafetyText", () => {
  it("reports raw unsafe public recipe text", () => {
    const issues = validateBrandSafetyText({
      batchContext: { brandSafety: { enabled: true } },
      outputs: [{
        outputId: "short",
        title: "Morderca wraca",
        timeline: [{
          segmentId: "s1",
          textOverlays: [{ overlayId: "o1", text: "Kurwa" }],
        }],
      }],
    });

    assert.equal(issues.length, 2);
    assert.ok(issues.every((issue) => issue.code === "V27-SAFETY-01"));
  });

  it("allows neutral identity references and already masked terms", () => {
    const issues = validateBrandSafetyText({
      outputs: [{
        outputId: "main",
        title: "Rozmowa z Żydem",
        timeline: [{
          segmentId: "s1",
          textOverlays: [{ overlayId: "o1", text: "m******a" }],
        }],
      }],
    });

    assert.deepEqual(issues, []);
  });
});
