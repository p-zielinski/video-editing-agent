import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SuperDirectorPlanSchema,
  coerceNoteString,
} from "./super-director-plan.js";

describe("coerceNoteString", () => {
  it("returns trimmed strings unchanged", () => {
    assert.equal(coerceNoteString("  hello  "), "hello");
  });

  it("joins nested arrays with semicolon separator", () => {
    assert.equal(coerceNoteString(["c", "d"]), "c; d");
  });

  it("extracts note, text, or message from objects", () => {
    assert.equal(coerceNoteString({ note: "x" }), "x");
    assert.equal(coerceNoteString({ text: "x" }), "x");
    assert.equal(coerceNoteString({ message: "x" }), "x");
  });

  it("stringifies unknown objects", () => {
    assert.equal(coerceNoteString({ foo: "bar" }), JSON.stringify({ foo: "bar" }));
  });

  it("returns empty string for null and undefined", () => {
    assert.equal(coerceNoteString(null), "");
    assert.equal(coerceNoteString(undefined), "");
  });
});

describe("SuperDirectorPlanSchema crossSegmentNotes", () => {
  const basePlan = {
    segmentOrder: [],
    segmentPicks: [],
    crossSegmentCallbacks: [],
    shortsSources: [],
    excludedClips: [],
  };

  it("keeps an array of strings unchanged", () => {
    const result = SuperDirectorPlanSchema.parse({
      ...basePlan,
      crossSegmentNotes: ["Most z seg001", "Zachowaj hook"],
    });
    assert.deepEqual(result.crossSegmentNotes, ["Most z seg001", "Zachowaj hook"]);
  });

  it("coerces nested arrays to joined strings", () => {
    const result = SuperDirectorPlanSchema.parse({
      ...basePlan,
      crossSegmentNotes: ["a", "b", ["c", "d"], "e"],
    });
    assert.deepEqual(result.crossSegmentNotes, ["a", "b", "c; d", "e"]);
  });

  it("coerces object notes to extracted or stringified values", () => {
    const result = SuperDirectorPlanSchema.parse({
      ...basePlan,
      crossSegmentNotes: [
        { note: "bridge seg001" },
        { text: "cold open hint" },
        { message: "callback setup" },
        { other: "value" },
      ],
    });
    assert.deepEqual(result.crossSegmentNotes, [
      "bridge seg001",
      "cold open hint",
      "callback setup",
      JSON.stringify({ other: "value" }),
    ]);
  });

  it("defaults null and undefined crossSegmentNotes to empty array", () => {
    assert.deepEqual(
      SuperDirectorPlanSchema.parse({ ...basePlan, crossSegmentNotes: null }).crossSegmentNotes,
      [],
    );
    assert.deepEqual(
      SuperDirectorPlanSchema.parse({ ...basePlan }).crossSegmentNotes,
      [],
    );
  });

  it("wraps a single top-level string as one-element array", () => {
    const result = SuperDirectorPlanSchema.parse({
      ...basePlan,
      crossSegmentNotes: "single note",
    });
    assert.deepEqual(result.crossSegmentNotes, ["single note"]);
  });

  it("filters empty notes after coercion", () => {
    const result = SuperDirectorPlanSchema.parse({
      ...basePlan,
      crossSegmentNotes: ["ok", "", "  ", null, undefined, []],
    });
    assert.deepEqual(result.crossSegmentNotes, ["ok"]);
  });
});
