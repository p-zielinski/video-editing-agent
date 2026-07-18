# Mountain trip batch 3f4edcc9

> Last updated: 2026-07-18
> Branch: local worktree
> Status: done (with stubs / GPT bypass)

## Problem & goal

Run full pipeline on `/Volumes/sd-card/2026.07.17` birthday/mountain footage. Get a validated final recipe and publish artifacts despite ML stubs and OpenAI quota limits.

## Scope

- **In scope:** Resume batch `3f4edcc9`, harden fixer/schema/enrichers so review/final can converge, finish thumbnails+publish.
- **Out of scope:** Live vision/Florence/TwelveLabs quality; live GPT review after quota exhaustion.

## Key files & context

| Area | Path | Role |
|------|------|------|
| Work dir | `output/.work/3f4edcc9/` | Batch artifacts |
| Final recipe | `09-edit-recipe-final.json` | Written via `enrich --target final` |
| Fixer merge | `src/agents/fixer.js` | Output/cut/audioMixPlan sanitization |
| Role coerce | `src/schemas/edit-recipe-v2.js` | bridge→beat/retention_beat |
| Hard-error sanitize | `src/editorial/recipe-hard-error-sanitize.js` | Cuts, scene reuse, unmatched broll |
| Retention beats | `src/editorial/shorts-retention.js` | Safe cut_on_beat + min-beat backfill |
| Payoff enrich | `src/editorial/payoff-enrich.js` | Multi-loop payoffs + scene segment mapping |

## Decisions

- 2026-07-18: After OpenAI 429 quota, bypass GPT review with `enrich --source draft --target final --force --face-stub`.
- 2026-07-18: Thumbnails with `--thumbnail-stub` due to same quota.
- 2026-07-18: Draft creativity raised to `balanced` / density 0.8 so enrich moments validate.

## Progress

- [x] Analysis through direct + audio enhancement
- [x] Fixer/schema hardening for GPT slop
- [x] Deterministic hard-error sanitizers
- [x] Payoff open-loop delivery for trimmed scenes
- [x] `09-edit-recipe-final.json` written
- [x] Thumbnails (stub) + publish completed

## Next steps

1. Top up OpenAI quota and optionally re-run review + live thumbnails.
2. Re-run with live vision when RAM/model allows (drop `--vision-stub`).
3. Render outputs from final recipe if not already rendered.

## Verification

```bash
node src/cli.js enrich --batch-id 3f4edcc9 --source draft --target final --force --face-stub
# Walidacja: OK

npm run full -- --batch-id 3f4edcc9 --from-step thumbnails \
  --twelvelabs-stub --no-objects --vision-stub --thumbnail-stub
# exit 0
```
