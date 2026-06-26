import { test } from "node:test";
import assert from "node:assert/strict";

/** Mirrors CLI → runPipeline flag resolution in cli.js */
function resolveObjectsFlags(args = {}) {
  return {
    objectsStub: args.objectsStub === true,
    objectsEnabled: args.objectsEnabled !== false,
  };
}

test("objects step defaults to live Florence (objectsStub=false)", () => {
  assert.deepEqual(resolveObjectsFlags({}), {
    objectsStub: false,
    objectsEnabled: true,
  });
});

test("--objects-stub enables stub mode without skipping step", () => {
  assert.deepEqual(resolveObjectsFlags({ objectsStub: true }), {
    objectsStub: true,
    objectsEnabled: true,
  });
});

test("--no-objects disables objects step", () => {
  assert.deepEqual(resolveObjectsFlags({ objectsEnabled: false }), {
    objectsStub: false,
    objectsEnabled: false,
  });
});
