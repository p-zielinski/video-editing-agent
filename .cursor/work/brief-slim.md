# Director brief slim

> Last updated: 2026-07-23
> Branch: `main` (local)
> Status: done (fixture + code; no live OpenAI)

## Problem & goal

Segment/drill-down director prompts were huge (~136k–180k promptTokens on `51cd206d`) even after L1 integrity work. Goal: keep segment briefs under **~40k estimated tokens** (chars/4) with clean L1, and slim drill-down to fingerprint + scene details instead of full `draftRecipe` + catalogs + schema.

## Scope

- **In scope:** Fixture clean L1/L2; catalog compaction; tighter audio caps; L1-aware word caps; slim drill-down payload; metrics tests/docs
- **Out of scope:** Live abstract re-run of `51cd206d`; scene-map threshold changes; model routing

## Key files & context

| Area | Path | Role |
|------|------|------|
| Fixture | `src/agents/fixtures/abstract-diverse-l1/` | Synthetic clean L1 (≥9 unique) + L2×2 |
| Caps | `src/editorial/brief-caps.js` | `TECHNIQUE_CATALOG_MAX_CHARS`, L1 word slim, `SEGMENT_BRIEF_ESTIMATED_TOKEN_BUDGET` |
| Catalog | `src/editorial/format-catalog-for-prompt.js` | `maxChars` compact + `formatCatalogIdListForPrompt` |
| Audio | `src/editorial/audio-index-summary.js` | Tightened `DIRECTOR_AUDIO_CAPS` |
| Brief | `src/agents/director.js` | `resolveMaxWordsPerSceneForBrief`, fingerprint, `buildDrillDownUserPayload` |
| Tests | `src/agents/brief-slim.test.js` | Offline metrics + shape assertions |

## Decisions

- 2026-07-23: Prefer fixture over mutating production `51cd206d` abstracts for tests; optional synthetic patch script is separate and backs up first.
- 2026-07-23: When unique L1 coverage ≥ 0.7, `maxWordsPerScene` drops 120 → 40.
- 2026-07-23: Drill-down drops `draftRecipe` + `outputSchema`; sends `draftRecipeFingerprint` + `outputTimelinesSummary` + `fixInstructions` + id-list technique catalog.

## Progress

- [x] Diverse L1/L2 fixture
- [x] Segment brief catalog/audio/words slim
- [x] Slim drill-down
- [x] Fixture metrics tests (no OpenAI)
- [x] Docs

## Fixture metrics (offline, `abstract-diverse-l1`)

| Metric | Value |
|--------|-------|
| Segment brief (`seg001` + outputSchema) | **72 870 bytes / ~18 218 est. tokens** |
| Segment budget | **40 000** est. tokens (`SEGMENT_BRIEF_ESTIMATED_TOKEN_BUDGET`) |
| Technique catalog full → slim | 9 121 → **3 031** chars (max 4 500) |
| Words/scene with good L1 | **40** (`maxWordsPerSceneWhenL1Good`) |
| Drill-down slim vs legacy shape | **46 201 / 64 138 bytes (~72%)** |

Legacy comparison reconstructs prior shape: full `draftRecipe` + full catalog + `outputSchema`, minus fingerprint fields.

## Threshold (documented)

`SEGMENT_BRIEF_ESTIMATED_TOKEN_BUDGET = 40_000` estimated tokens ≈ `jsonBytes / 4` on the segment director **user** JSON (includes `outputSchema`). Enforced in `src/agents/brief-slim.test.js`.

## Verification

```bash
node --test src/agents/brief-slim.test.js src/agents/director.test.js \
  tests/agents/segment-director.test.js src/editorial/brief-caps.test.js \
  tests/editorial/format-catalog-for-prompt.test.js
```

## Next steps

1. After clean abstract on `51cd206d`, re-measure real `briefMetrics` / `16-gpt-usage.json`.
2. Optional: run `scripts/patch-abstract-diverse-l1-from-vision.mjs` only for local experiments (backs up first).

## Blockers / open questions

- None for offline slim; live batch still needs clean L1 re-run for production quality.
