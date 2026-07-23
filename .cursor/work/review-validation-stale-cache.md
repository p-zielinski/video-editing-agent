# Review validation + stale critic cache

> Last updated: 2026-07-19
> Branch: `main`
> Status: done

## Problem & goal

Batch `51cd206d` fails at `review` with `RECIPE_VALIDATION_FAILED` (7 errors). User reused `--reuse-llm-cache` without clearing critic/fixer caches.

**Done** = (1) review LLM caches do not apply to a different recipe shape; (2) deterministic sanitize + correct V21 level gating clear the hard errors that currently block `09-edit-recipe-final.json`.

## Scope

- **In scope:** V21-03 per-output creativity level; technique-cap / zoom-duty / vlog-beat sanitizers; critic/fixer/super_critic cache fingerprint; tests; verify on draft `07-edit-recipe-draft.json`.
- **Out of scope:** Re-running full GPT review for the batch in this session (user can re-run); shrinking drill_down brief.

## Key files & context

| Area | Path | Role |
|------|------|------|
| Draft | `output/.work/51cd206d/07-edit-recipe-draft.json` | Failing recipe |
| Critic cache | `llm-cache/critic__critic.json` | Stale: mentions `main_16x9` **and** `output_0_16x9` |
| Super critic | `llm-cache/super_critic__superCritic.json` | Stale from 12:33Z |
| Sanitize | `src/editorial/recipe-hard-error-sanitize.js` | Zoom duty, technique cap, vlog beats, NAR closure |
| Validate | `src/validators/creative-moments.js` | Per-output V21-03; retention grammar cap exempt |
| Cache key | `src/lib/recipe-review-cache-key.js` | Recipe fingerprint for review LLM caches |
| Review step | `src/pipeline/steps/agents.js` | `runReviewStep` |

## Decisions

- 2026-07-19: **Cache is a real factor** — critic issues reference two 16:9 mains (`output_0_16x9` + `main_16x9`); current draft has `main_16x9` + `short_9x16`. Super critic from earlier recipe. Fixer ran 3 attempts guided by wrong issues.
- 2026-07-19: **Draft also independently invalid** — even fresh critic would not save final write: `sanitizeRecipeHardErrors` leaves all 7 errors. V21-03 is a **validator bug** (short hooks gated against main `balanced` instead of short `shorts`). Short `maxTotalTechniqueMoments=1` fights required hook/payoff/closure grammar. Main has 12s zoom duty vs 2.6s cap; only 1 vlog beat (need 3).
- 2026-07-19: Fix plan — (a) per-output level for V21-03; (b) exempt hook/payoff/closure from technique cap (like beat pool); (c) sanitize zoom duty + excess decorative moments + missing vlog beats from `retentionBeatTargets`; (d) recipe fingerprint in critic/fixer/super_critic cache keys.
- 2026-07-19: `sanitizeMissingVlogRetentionBeats` only runs when `vlogRetentionProfile.enabled === true`; uses `cut_on_beat` via `resolveEnrichBeatTechniqueId` to avoid music_swell density clashes; runs before `sanitizeCreativeMomentDensity`.
- 2026-07-19 (Reviewer): **NAR-CLOSURE-SPAM root cause** — `sanitizeMissingVlogRetentionBeats` inserted `enrich_beat_sanitize_*` at retention target 138s inside resolution L2 output range (97–144s) *after* `sanitizeNarrativeBeatHardErrors` had already run. Fix: skip slow/breath + resolution ranges when inserting vlog beats; re-run narrative sanitize after all insertions; fallback scan for safe slots when targets are forbidden.

## Progress

- [x] Root-cause analysis
- [x] Validator + sanitize + cache fingerprint
- [x] Tests (54 pass in targeted suites)
- [x] Reviewer audit + verify draft validates (0 errors after sanitize)

## Next steps

1. User re-run: clear critic/fixer caches once OR rely on new fingerprint (`critic__critic__5da8c47a0cc9.json`), then `--from-step review`

## Blockers / open questions

- None

## Verification

```bash
node --test tests/editorial/recipe-hard-error-sanitize.test.js tests/editorial/creative-moments.test.js tests/lib/recipe-review-cache-key.test.js
```

Draft verify (2026-07-19 Reviewer): `sanitizeRecipeHardErrors` → `validateRecipeV2` → **0 errors** on batch `51cd206d` draft. Sanitize inserts beats at 75s and 93s (skips 138s resolution target).
