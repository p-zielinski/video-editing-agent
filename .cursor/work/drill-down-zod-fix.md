# Drill-down Zod rejection fix

> Last updated: 2026-07-23
> Branch: (local)
> Status: done

## Problem & goal

Batch `51cd206d` failed at `direct` → `drill_down` with Zod errors:
1. `renderStylePresets.formats[*]` missing required `width`/`height` (LLM returned only `safeArea`)
2. `editorialAssessment.verdict: "strong"` — L3 vocabulary, not recipe enum

Done = sanitize/coerce so valid drafts parse; poisoned drill_down cache cleared for fresh LLM.

## Scope

- **In scope:** schema coerce + sanitize backfill + tests + delete batch caches
- **Out of scope:** brief size soft-warns (~82k tokens)

## Key files & context

| Area | Path | Role |
|------|------|------|
| Verdict coerce | `src/schemas/edit-recipe-v2.js` | L3 aliases → recipe enum |
| Presets sanitize | `src/agents/director.js` | `sanitizeRenderStylePresets` |
| Defaults | `src/render/render-config.js`, `src/render/style-presets.js` | dimensions / safeZone |

## Decisions

- 2026-07-23: Coerce at schema + backfill in sanitize (not hand-edit cache). Fresh LLM without `--reuse-llm-cache`.

## Progress

- [x] Verdict alias coerce
- [x] renderStylePresets width/height + safeArea→safeZone
- [x] Unit tests
- [x] Delete `drill_down__*` caches for `51cd206d`
- [ ] User re-run from `direct`

## Next steps

1. Resume with command in Verification (no `--reuse-llm-cache`).

## Blockers / open questions

- None.

## Verification

```bash
node src/cli.js run --batch-id 51cd206d --from-step direct --render --render-profile production --force --context "Nagrane dzień przed 30. urodzinami — osobisty vlog o nadziei na nadchodzące trzydzieste lata, refleksji i tym, co zostaje z mijającego czasu."
```
