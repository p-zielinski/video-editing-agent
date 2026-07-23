import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backfillDirectorDraftContext } from "./director.js";
import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BATCH_CACHE = path.join(
  ROOT,
  "output/.work/51cd206d/llm-cache/drill_down__directorDrillDown__drill_down.json",
);
const PRIOR_RECIPE_PATH = path.join(
  ROOT,
  "output/.work/51cd206d/09-edit-recipe-final.json",
);

describe("director drill_down cache reuse", () => {
  it("parses cached batch 51cd206d drill_down response after backfill", { skip: !fs.existsSync(BATCH_CACHE) }, () => {
    const payload = JSON.parse(fs.readFileSync(BATCH_CACHE, "utf8"));
    const raw = structuredClone(payload.response);
    const cacheLackedOutputs = !Array.isArray(raw.outputs) || raw.outputs.length === 0;
    const priorFull = fs.existsSync(PRIOR_RECIPE_PATH)
      ? JSON.parse(fs.readFileSync(PRIOR_RECIPE_PATH, "utf8"))
      : null;
    const priorRecipe = {
      batchContext: priorFull?.batchContext ?? {
        inputMode: "single_clip",
        requiredFormats: ["16:9", "9:16"],
        theme: "vlog",
      },
      outputs: (Array.isArray(raw.outputs) && raw.outputs.length > 0)
        ? raw.outputs
        : priorFull?.outputs,
    };
    assert.ok(
      Array.isArray(priorRecipe.outputs) && priorRecipe.outputs.length > 0,
      "priorRecipe.outputs required for regression (cache lacks outputs)",
    );

    backfillDirectorDraftContext(raw, {
      priorRecipe,
      batchContext: priorRecipe.batchContext,
      requiredFormats: ["16:9", "9:16"],
    });

    const parsed = EditRecipeV2Schema.parse(raw);
    assert.ok(parsed.batchContext);
    assert.ok(parsed.outputs.length > 0, "outputs salvaged from priorRecipe");
    assert.equal(cacheLackedOutputs, true, "regression: broken cache shape without outputs");
    assert.equal(raw.segmentId, undefined, "spurious top-level segmentId stripped");
    for (const output of parsed.outputs) {
      for (const segment of output.timeline ?? []) {
        assert.ok(segment.audioPolicy, `missing audioPolicy on ${segment.segmentId}`);
      }
    }
    const hook = parsed.outputs
      .flatMap((output) => output.timeline ?? [])
      .find((segment) => segment.segmentRole === "ai_hook");
    if (hook) {
      assert.equal(hook.audioPolicy, "from_next");
    }
  });
});
