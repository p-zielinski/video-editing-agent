# narrativeIntent LLM coercion

> Last updated: 2026-07-20
> Branch: (current)
> Status: done

## Problem & goal

Batch `51cd206d` review crashed when fixer returned `narrativeIntent: "callback"` — valid for openLoops/L2 roles but not `NarrativeIntentSchema`. Parse must not hard-fail on known LLM aliases.

## Scope

- **In scope:** `NarrativeIntentSchema` preprocess in `edit-recipe-v2.js`, unit tests, stuck batch cache patch
- **Out of scope:** `recipe-hard-error-sanitize.js` (schema preprocess covers all parse sites)

## Key files

| Area | Path | Role |
|------|------|------|
| Schema | `src/schemas/edit-recipe-v2.js` | alias map + strip unknown |
| Tests | `src/schemas/edit-recipe-v2-narrative-intent.test.js` | coercion assertions |
| Batch cache | `output/.work/51cd206d/llm-cache/fixer__fixer__41952397922a-attempt-1.json` | `callback` → `reveal` |

## Decisions

- 2026-07-20: `callback` → `reveal`, `flashback` → `memory`; unknown strings → `undefined` (V21-16 warns rather than inventing `transition`).

## Progress

- [x] Schema-level `z.preprocess` on `NarrativeIntentSchema`
- [x] Unit tests
- [x] Patched stuck batch cache; deleted `__rejected.json` sibling

## Verification

```bash
node --test src/schemas/edit-recipe-v2-narrative-intent.test.js
```
