# Consistency Auditor + layout napisów

> Last updated: 2026-07-20
> Branch: `main` (local)
> Status: done

## Problem & goal

Osobny deterministyczny Consistency Auditor (nie GPT critic) łapie nonsensy czasowe i kolizje napisów/overlayów, bezpiecznie je sanituje, oraz daje reżyserowi `subtitles.placement`.

## Scope

- **In scope:** validator + sanitize, schema placement, ASS Alignment, layout bands, artefakt 08b, docs
- **Out of scope:** nowy LLM fixer, pixel bbox/face-avoidance, Remotion

## Key files & context

| Area | Path | Role |
|------|------|------|
| Validator | `src/validators/recipe-consistency.js` | CONS-TL / TX / LAY |
| Sanitize | `src/editorial/recipe-consistency-sanitize.js` | safe fixes |
| Hook | `src/pipeline/steps/agents.js` | po hard-error sanitize |
| Schema | `src/schemas/edit-recipe-v2.js` | `subtitles.placement` |
| ASS | `src/render/ass-subtitles.js` | Alignment z placement |
| Artefakt | `08b-consistency-audit.json` | issues + fixes |

## Decisions

- 2026-07-20: bez LLM na końcu — tylko deterministyczna auto-naprawa + raport
- 2026-07-20: priorytet overlay: payoff > hook > chapter > emphasis > cta
- 2026-07-20: CONS-TL-02 (gap/excess overlap) = **warning** — rewind/J-cut overlap nie blokuje final
- 2026-07-20: creativeMoments CONS-TL-03 tylko poza output span (nie owning segment)

## Progress

- [x] Faza 1: auditor timing/tekst + hook + 08b
- [x] Faza 2: placement schema + ASS + director prompt
- [x] Faza 3: layout bands + sanitize kolizji
- [x] Faza 4: ARTIFACTS, PIPELINE.md, handoff

## Next steps

1. Opcjonalnie: re-run `review` na batchu i porównanie `08b` vs render
2. Później: face-aware placement ze spatial index

## Blockers / open questions

- (none)

## Verification

- `node --test src/validators/recipe-consistency.test.js src/render/ass-subtitles.test.js` — 21 pass
- Smoke `runConsistencyAuditor` na `51cd206d/09-edit-recipe-final.json` → approved (1× move_overlay_band, CONS-TL-02 warning)
- `npm run export-schemas` — `placement` w EditRecipeV2.schema.json
