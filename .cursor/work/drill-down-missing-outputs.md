# Drill-down missing `outputs` (Zod crash)

> Last updated: 2026-07-19 (Reviewer: approved)
> Branch: `main`
> Status: done

## Problem & goal

Batch `51cd206d` fails at `direct` → `drill_down` with:

```json
[{"code":"invalid_type","expected":"array","received":"undefined","path":["outputs"],"message":"Required"}]
```

**Done** = drill_down never hard-fails solely because LLM omitted `outputs` when a prior recipe timeline exists; regression test covers the real cache shape; prompt discourages segment-director confusion.

## Scope

- **In scope:** `backfillDirectorDraftContext` salvage, `directorDrillDown` logging, `prompts/v2/director.md` drill_down rules, unit tests, verify against batch cache.
- **Out of scope:** shrinking 160k drill_down brief, model upgrade, manual cache surgery as the primary fix.

## Key files & context

| Area | Path | Role |
|------|------|------|
| Backfill | `src/agents/director.js` | `backfillDirectorDraftContext`, `directorDrillDown` |
| Prompt | `prompts/v2/director.md` | `task: drill_down_refine` |
| Schema | `src/schemas/edit-recipe-v2.js` | `outputs` required min(1) |
| Failing cache | `output/.work/51cd206d/llm-cache/drill_down__directorDrillDown__drill_down.json` | response without `outputs` |
| Rejection | `…/drill_down__directorDrillDown__drill_down__rejected.json` | Zod issues |

## Decisions

- 2026-07-19: Root cause — `gpt-5.4-mini` returned metadata-only EditRecipe (`segmentId: seg001`, salvage/excluded/creativeMoments) and **omitted** `outputs`. Shared `director.md` with `segment_director_draft` + huge brief (~159k prompt tokens) encourages confusion / truncation of the largest field. Completion was 5638 tokens (prior successful drill_down on same batch: 8596).
- 2026-07-19: Primary fix = **salvage `outputs` from `priorRecipe`** in `backfillDirectorDraftContext` when missing/empty. Drill-down already receives the merged super/classic draft; metadata overlay without timelines must not abort the pipeline.
- 2026-07-19: Also strip spurious top-level `segmentId` (segment-director marker on full recipes). Prompt hardening for `drill_down_refine`.

## Progress

- [x] Root-cause analysis of rejected cache
- [x] Backfill missing/empty `outputs` from priorRecipe
- [x] Strip top-level `segmentId`; prompt harden
- [x] Unit tests (incl. real cache shape)
- [x] Reviewer pass + re-run parse against batch cache

## Next steps

1. Re-run batch with cache: `node src/cli.js run --batch-id 51cd206d --from-step direct --to-step review --reuse-llm-cache`
2. Follow-up (optional): shrink ~160k drill_down brief if metadata-only responses recur despite salvage.

## Blockers / open questions

- None.

## Verification

```bash
node --test src/agents/director.test.js src/agents/director-drilldown-cache.test.js
# 73 tests pass (2026-07-19 reviewer)

# End-to-end on batch 51cd206d cache + 09-edit-recipe-final.json:
# sanitizeDirectorDraft → backfillDirectorDraftContext → EditRecipeV2Schema.parse — OK
# (outputs salvaged: output_0_16x9, output_1_9x16; segmentId stripped)

# After fix, reuse cache:
# node src/cli.js run --batch-id 51cd206d --from-step direct --to-step review --reuse-llm-cache
```
