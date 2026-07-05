import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hashRecipe,
  snapshotRecipeStage,
  diffRecipeSummaries,
  countRecipeSummary,
  createEnricherAuditWrapper,
  buildProvenanceDocument,
  stripRecipeProvenanceFields,
  writeRecipeProvenance,
} from "./recipe-provenance.js";
import { ARTIFACTS } from "../pipeline/work-paths.js";

function makeRecipe(overrides = {}) {
  return {
    version: "2.0",
    batchId: "batch01",
    outputs: [
      {
        outputId: "main",
        timeline: [
          { segmentId: "s1", cuts: [{ atSec: 1 }] },
          { segmentId: "s2", cuts: [] },
        ],
      },
    ],
    creativeMoments: [{ momentId: "m1" }],
    sfxPlan: [],
    ...overrides,
  };
}

describe("recipe-provenance", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-provenance-"));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("hashRecipe is stable for identical JSON", () => {
    const recipe = makeRecipe();
    assert.equal(hashRecipe(recipe), hashRecipe({ ...recipe }));
  });

  it("snapshotRecipeStage counts segments, cuts, and moments", () => {
    const snapshot = snapshotRecipeStage(makeRecipe(), "afterDirector");
    assert.equal(snapshot.stageName, "afterDirector");
    assert.equal(snapshot.segments, 2);
    assert.equal(snapshot.cuts, 1);
    assert.equal(snapshot.creativeMoments, 1);
    assert.equal(snapshot.sfxPlan, 0);
    assert.match(snapshot.hash, /^[a-f0-9]{64}$/);
  });

  it("diffRecipeSummaries reports additive deltas", () => {
    const before = countRecipeSummary(makeRecipe());
    const after = countRecipeSummary(makeRecipe({
      outputs: [{
        outputId: "main",
        timeline: [
          { segmentId: "s1", cuts: [{ atSec: 1 }, { atSec: 2 }] },
          { segmentId: "s2", cuts: [] },
          { segmentId: "s3", cuts: [] },
        ],
      }],
      creativeMoments: [{ momentId: "m1" }, { momentId: "m2" }],
      sfxPlan: [{ sfxId: "riser" }],
    }));

    assert.deepEqual(diffRecipeSummaries(before, after), {
      segmentsAdded: 1,
      segmentsRemoved: 0,
      cutsAdded: 1,
      creativeMomentsAdded: 1,
      sfxPlanAdded: 1,
    });
  });

  it("createEnricherAuditWrapper logs per-enricher deltas", () => {
    const recipe = makeRecipe();
    const wrapped = createEnricherAuditWrapper(() => [
      {
        name: "addSegment",
        apply: () => {
          recipe.outputs[0].timeline.push({ segmentId: "s3", cuts: [] });
        },
      },
      {
        name: "addSfx",
        apply: () => {
          recipe.sfxPlan.push({ sfxId: "whoosh" });
        },
      },
    ]);

    const { enricherLog } = wrapped(recipe, {});
    assert.equal(enricherLog.length, 2);
    assert.equal(enricherLog[0].enricher, "addSegment");
    assert.equal(enricherLog[0].delta.segmentsAdded, 1);
    assert.equal(enricherLog[1].enricher, "addSfx");
    assert.equal(enricherLog[1].delta.sfxPlanAdded, 1);
  });

  it("buildProvenanceDocument assembles audit payload", () => {
    const doc = buildProvenanceDocument({
      batchId: "batch01",
      afterDirector: snapshotRecipeStage(makeRecipe(), "afterDirector"),
      afterEnrichers: snapshotRecipeStage(makeRecipe({ sfxPlan: [{ sfxId: "x" }] }), "afterEnrichers"),
      afterReview: snapshotRecipeStage(makeRecipe(), "afterReview"),
      enricherLog: [{ enricher: "test", delta: { segmentsAdded: 0 } }],
      stitchValidation: { valid: true, issues: [] },
      superCriticReview: { approved: true },
      reviewIterations: 2,
    });

    assert.equal(doc.version, "1.0");
    assert.equal(doc.batchId, "batch01");
    assert.equal(doc.reviewIterations, 2);
    assert.equal(doc.stitchValidation.valid, true);
    assert.equal(doc.superCriticReview.approved, true);
  });

  it("stripRecipeProvenanceFields removes audit-only fields", () => {
    const { recipe, stitchValidation, superCriticReview } = stripRecipeProvenanceFields(makeRecipe({
      stitchValidation: { valid: true, issues: [] },
      superCriticReview: { approved: true },
    }));

    assert.equal(stitchValidation.valid, true);
    assert.equal(superCriticReview.approved, true);
    assert.equal(recipe.stitchValidation, undefined);
    assert.equal(recipe.superCriticReview, undefined);
  });

  it("writeRecipeProvenance writes 14-recipe-provenance.json", () => {
    const doc = buildProvenanceDocument({ batchId: "batch01" });
    const outPath = writeRecipeProvenance(workDir, doc);
    assert.equal(outPath, path.join(workDir, ARTIFACTS.recipeProvenance));
    assert.ok(fs.existsSync(outPath));
    const saved = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(saved.batchId, "batch01");
  });
});
