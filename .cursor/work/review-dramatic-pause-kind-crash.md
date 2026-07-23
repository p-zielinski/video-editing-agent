# Review failures: dramatic pause kind + RECIPE_VALIDATION_FAILED

> Last updated: 2026-07-19
> Branch: `main`
> Status: done

## Problem & goal

1. Krok `review` padał TypeError `reading 'kind'` (~35 ms).
2. Po fixie TypeError review kończył się `RECIPE_VALIDATION_FAILED` (7 hard errors), mimo pętli critic/fixer + LLM cache.

Cel: odblokować zapis `09-edit-recipe-final.json` i zapobiec powtórce.

## Scope

- **In scope:** null-safe `isDramaticPauseHint`; deterministic hard-error sanitize (SCENE_EXCLUDED, V21-04/05, NAR beats); `computeScaledMinRetentionBeats(0)→0`; final sanitize przed walidacją w review.
- **Out of scope:** przepisywanie recovery templates; zmiana fuzji dead-air; LLM fixer prompts.

## Key files & context

| Area | Path | Role |
|------|------|------|
| TypeError | `src/validators/narrative.js` | `isDramaticPauseHint` |
| Hard sanitize | `src/editorial/recipe-hard-error-sanitize.js` | SCENE_EXCLUDED / V21 / NAR |
| Review step | `src/pipeline/steps/agents.js` | final sanitize przed validate |
| Vlog exempt | `src/editorial/shorts-retention.js` | `computeScaledMinRetentionBeats` |
| Tests | `tests/editorial/recipe-hard-error-sanitize.test.js` | regresja |

## Decisions

- 2026-07-19: null-safe `isDramaticPauseHint` zamiast zmiany merge tagged/raw hints.
- 2026-07-19: gdy whole_clip exclusion koliduje z timeline — **usuń exclusion** (nie `usableAsBroll:true`, bo to EXCLUSION_USABLE_BROLL_WHOLE_CLIP).
- 2026-07-19: NAR hard-mode (`internet_documentary`) — usuń beaty w slow/breath; density V21 — drop excess music_* moments.
- 2026-07-19: gdy cały main jest exempt jako slow, effectiveDuration=0 → min beats musi być 0 (nie 2).
- 2026-07-19: thumbnails — brakujący import `resolvePublishVoice` w `thumbnails.js`.

## Progress

- [x] TypeError `kind` fixed + test
- [x] Sanitize SCENE_EXCLUDED / V21-04/05 / NAR-BEAT/BREATH/CLOSURE
- [x] Final sanitize w `runReviewStep` przed walidacją
- [x] `computeScaledMinRetentionBeats(0) === 0`
- [x] Smoke batch `51cd206d`: po sanitize `validateRecipeV2` → valid, 0 errors
- [x] Fix `resolvePublishVoice is not defined` w kroku thumbnails

## Next steps

1. Wznowić: `npm run full -- --batch-id 51cd206d --from-step review --reuse-llm-cache …`

## Blockers / open questions

- Brak

## Verification

```bash
node --test tests/editorial/recipe-hard-error-sanitize.test.js src/validators/narrative.test.js
# pass

# smoke 51cd206d draft after sanitizeRecipeHardErrors → valid: true, errors: 0
```
