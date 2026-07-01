import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, resolveMaxReviewIterations } from "./cli.js";
import { buildExecuteRenderOptions } from "./render/render-config.js";
import { validatePipelineStep } from "./pipeline/work-paths.js";

describe("cli", () => {
  it("validatePipelineStep returns error message for typo", () => {
    const error = validatePipelineStep("spatial_indx", "--from-step");
    assert.ok(error);
    assert.match(error, /--from-step musi być jednym z:/);
    assert.match(error, /spatial_index/);
  });

  it("parseArgs sets fromStep spatial_index", () => {
    const args = parseArgs([
      "node", "cli.js", "run",
      "--batch-id", "abc12345",
      "--from-step", "spatial_index",
      "--to-step", "spatial_index",
    ]);
    assert.equal(args.command, "run");
    assert.equal(args.batchId, "abc12345");
    assert.equal(args.fromStep, "spatial_index");
    assert.equal(args.toStep, "spatial_index");
  });

  it("parseArgs applies command defaults for analyze", () => {
    const args = parseArgs(["node", "cli.js", "analyze", "--input", "./inbox"]);
    assert.equal(args.command, "analyze");
    assert.equal(args.fromStep, "ingest");
    assert.equal(args.toStep, "index");
    assert.equal(args.input, "./inbox");
  });

  it("parseArgs applies command defaults for direct", () => {
    const args = parseArgs(["node", "cli.js", "direct", "--batch-id", "x"]);
    assert.equal(args.fromStep, "abstract");
    assert.equal(args.toStep, "review");
  });

  it("parseArgs sets report command with batch-id", () => {
    const args = parseArgs(["node", "cli.js", "report", "--batch-id", "abc12345"]);
    assert.equal(args.command, "report");
    assert.equal(args.batchId, "abc12345");
  });

  it("parseArgs sets faceLive with --face-live alias", () => {
    const args = parseArgs([
      "node", "cli.js", "run",
      "--input", "./inbox",
      "--face-live",
    ]);
    assert.equal(args.faceLive, true);
    assert.equal(args.faceStub, false);
  });

  it("parseArgs sets faceStub with --face-stub", () => {
    const args = parseArgs(["node", "cli.js", "run", "--input", "./inbox", "--face-stub"]);
    assert.equal(args.faceStub, true);
  });

  it("parseArgs rejects removed --fast flag", () => {
    assert.throws(
      () => parseArgs(["node", "cli.js", "run", "--input", "./inbox", "--fast"]),
      /--fast została usunięta/,
    );
  });

  it("parseArgs defaults to live mode without stub flags", () => {
    const args = parseArgs(["node", "cli.js", "run", "--input", "./inbox"]);
    assert.equal(args.faceLive, undefined);
    assert.equal(args.faceStub, undefined);
    assert.equal(args.visionStub, undefined);
    assert.equal(args.audioStub, undefined);
  });

  it("parseArgs --vision-live forces live vision after --vision-stub", () => {
    const args = parseArgs([
      "node", "cli.js", "run",
      "--input", "./inbox",
      "--vision-stub",
      "--vision-live",
    ]);
    assert.equal(args.visionStub, false);
  });

  it("parseArgs --min-outputs sets explicit requiredFormats", () => {
    const args = parseArgs([
      "node", "cli.js", "run",
      "--input", "./inbox",
      "--min-outputs", "9:16",
    ]);
    assert.deepEqual(args.requiredFormats, ["9:16"]);
    assert.equal(args.requiredFormatsExplicit, true);
  });

  it("parseArgs sets --render and --render-profile", () => {
    const args = parseArgs([
      "node", "cli.js", "run",
      "--input", "./inbox",
      "--render",
      "--render-profile", "preview",
    ]);
    assert.equal(args.renderAfterPipeline, true);
    assert.equal(args.renderProfile, "preview");
    const options = buildExecuteRenderOptions(args);
    assert.equal(options.skipCreative, true);
    assert.equal(options.encodeProfile, "draft");
  });

  it("parseArgs sets enrich source and target", () => {
    const args = parseArgs([
      "node", "cli.js", "enrich",
      "--batch-id", "abc12345",
      "--source", "final",
      "--target", "draft",
    ]);
    assert.equal(args.command, "enrich");
    assert.equal(args.recipeSource, "final");
    assert.equal(args.recipeTarget, "draft");
  });

  it("parseArgs sets --max-review-iterations", () => {
    const args = parseArgs([
      "node", "cli.js", "run",
      "--input", "./inbox",
      "--max-review-iterations", "5",
    ]);
    assert.equal(args.maxReviewIterations, "5");
  });

  it("resolveMaxReviewIterations defaults to 3 and validates range", () => {
    assert.equal(resolveMaxReviewIterations(undefined), 3);
    assert.equal(resolveMaxReviewIterations("5"), 5);
    assert.equal(resolveMaxReviewIterations("1"), 1);
    assert.equal(resolveMaxReviewIterations("10"), 10);
    assert.throws(() => resolveMaxReviewIterations("0"), /--max-review-iterations/);
    assert.throws(() => resolveMaxReviewIterations("11"), /--max-review-iterations/);
    assert.throws(() => resolveMaxReviewIterations("abc"), /--max-review-iterations/);
  });
});
