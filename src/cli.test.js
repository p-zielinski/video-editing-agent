import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./cli.js";
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

  it("parseArgs --fast enables vision, face, and audio stubs", () => {
    const args = parseArgs(["node", "cli.js", "run", "--input", "./inbox", "--fast"]);
    assert.equal(args.fast, true);
    assert.equal(args.visionStub, true);
    assert.equal(args.faceStub, true);
    assert.equal(args.audioStub, true);
  });

  it("parseArgs defaults to live mode without stub flags", () => {
    const args = parseArgs(["node", "cli.js", "run", "--input", "./inbox"]);
    assert.equal(args.faceLive, undefined);
    assert.equal(args.faceStub, undefined);
    assert.equal(args.visionStub, undefined);
    assert.equal(args.audioStub, undefined);
    assert.equal(args.fast, undefined);
  });

  it("parseArgs --vision-live forces live vision", () => {
    const args = parseArgs([
      "node", "cli.js", "run",
      "--input", "./inbox",
      "--fast",
      "--vision-live",
    ]);
    assert.equal(args.visionStub, false);
  });
});
