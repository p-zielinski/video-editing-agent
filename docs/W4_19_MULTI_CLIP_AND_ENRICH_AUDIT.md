# W4.19 — Multi-clip flow + deterministic enrichers

> Last updated: 2026-06-29  
> Status: **superseded by W4.20** — see `docs/W4_20_MULTI_CLIP_ENRICH_CLOSEOUT.md`

## Summary

Sprint closes gaps from multi-clip inbox analysis and `MONTAZ_AUDIT_2026-06-29.md` P0 items.

### Multi-clip chronology

| Change | Files |
|--------|-------|
| `creationTime` in `clipRegistry` | `clip-profile.js`, `edit-recipe-v2.js` |
| Auto sort: multi-clip → `creation_time` | `input-mode.js`, `ingest.js`, `cli.js` |
| `daySegments[]` in director brief | `abstraction-chunking.js`, `director.js` |
| L2 chunking by `sortIndex` | `abstraction-chunking.js`, `summarizer.js` |
| Dynamic compact threshold (50 + 10×clips) | `director.js` |
| Per-clip floor in `selectScenesForDirectorMap` | `director.js` |
| `brollStrategy` prompt + `constraints` | `prompts/v2/director.md`, `director.js` |

### Deterministic enrichers (post-director)

| Enricher | File |
|----------|------|
| `enrichBrollSyncFromHints` | `broll-sync-hints.js` |
| `enrichRecipeColdOpenSegment` | `chapter-hints.js` |
| `spatialRef` timestamp fallback (no synthetic bbox) | `shorts-retention.js` |
| `applyDeterministicRecipeEnrichers` | `agents.js` |

## Quality estimate (multi-clip vlog)

| Before | After |
|--------|-------|
| ~70% | ~82% |

## Remaining gaps (next sprint)

### P0

- **Cold-open rewind** — enrich prepends tease only; no rewind segment / overlay
- **Chronology validator** — no check that main timeline respects `sortIndex` / `daySegments`
- **`brollStrategy` enforcement** — prompt-only; critic/validator don't gate violations

### P1

- `directorDrillDown` missing `daySegments`, `brollSyncHints`, `coldOpenSegmentHint`
- `deadAirMontageHints` → `silence_beat` enrich (still brief-only)
- CLI help: document multi-clip default `creation_time`
- E2E fixture: add `creationTime` to mini-day for regression

### P2

- Render toggles (`--skip-creative`, etc.)
- Per-output `colorGrade`
- Full cold-open montage with audio bridge

## Verification

```bash
node --test src/lib/input-mode.test.js src/lib/abstraction-chunking.test.js \
  src/pipeline/steps/clip-profile.test.js src/agents/director.test.js \
  tests/editorial/broll-sync-hints.test.js tests/editorial/retention-enrich.test.js
```

Full unit suite (excl. e2e): 846 pass / 0 fail.
