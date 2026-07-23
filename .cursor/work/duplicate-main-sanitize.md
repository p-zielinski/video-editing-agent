# Duplicate main sanitize + hard-error fixes

> Last updated: 2026-07-20
> Branch: (local)
> Status: done

## Problem & goal

Batch `51cd206d` draft could not pass `validateRecipeV2` after review because of duplicate `16:9` outputs, gated `match_cut`, and vlog beat gaps. Goal: deterministic sanitizers reach **0 validation errors** on `07-edit-recipe-draft.json`.

## Scope

- **In scope:** `sanitizeDuplicateSameFormatOutputs`, `sanitizeCreativityLevelGate`, vlog beat / word-cut / misclassified beat fixes, resolution fallback alignment, unit tests, batch draft patch.
- **Out of scope:** writing `09-edit-recipe-final.json` (review step).

## Key files & context

| Area | Path | Role |
|------|------|------|
| Sanitizers | `src/editorial/recipe-hard-error-sanitize.js` | All new/fix sanitizers + pipeline order |
| Narrative validator | `src/validators/narrative.js` | Resolution L2 only when `narrativeRole === "resolution"` |
| Tests | `tests/editorial/recipe-hard-error-sanitize.test.js` | Dedupe + creativity gate tests |
| Batch draft | `output/.work/51cd206d/07-edit-recipe-draft.json` | Patched in place |

## Decisions

- 2026-07-20: Prefer canonical output ids (`main_16x9`, `short_9x16`) when deduping same-format outputs; remap moments, retention targets, audio mix, scene registry.
- 2026-07-20: `sanitizeCreativityLevelGate` uses per-output creativity budget (drops `match_cut` at `balanced`).
- 2026-07-20: Vlog beat insert runs **last** (after NAR trim); strips `retentionRole: beat` from non-vlog techniques (e.g. `cinematic_frame` on `cm_main_01`).
- 2026-07-20: Cadence loop fills `V22-VLOG-02` gaps up to `maxRetentionBeatMoments`; sanitized beat ids use `sanitize_vlog_beat_*` (not `enrich_beat_*`).
- 2026-07-20: `resolveResolutionL2Segment` no longer falls back to last L2 when no explicit resolution (fixes false `NAR-CLOSURE-SPAM` when final L2 is `development`).
- 2026-07-20: `sanitizeInvalidWordCuts` drops wordIds missing from word index when indexes provided.

## Progress

- [x] `sanitizeDuplicateSameFormatOutputs`
- [x] `sanitizeCreativityLevelGate`
- [x] Vlog beat cadence + misclassified role + word-cut fixes
- [x] Unit tests (20 sanitizer + narrative suite pass)
- [x] Batch `51cd206d` draft → **0 errors** (21 warnings)

## Verification

```bash
node --test tests/editorial/recipe-hard-error-sanitize.test.js
# Batch: sanitize 07-edit-recipe-draft.json with abstraction + wordIndexes → validateRecipeV2 → 0 errors
```

## Blockers / open questions

- None for draft sanitization. Review step should still write `09-final` from sanitized draft.
