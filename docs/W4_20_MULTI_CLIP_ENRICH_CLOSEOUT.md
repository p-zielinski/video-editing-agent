# W4.20 — Multi-clip enrich closeout + montage audit

> Last updated: 2026-06-29  
> Status: **implemented** (P0 from W4.19 audit closed)

## Summary

Sprint closes remaining P0/P1 gaps from `docs/W4_19_MULTI_CLIP_AND_ENRICH_AUDIT.md`.

### Implemented

| Area | Change | Files |
|------|--------|-------|
| Cold-open rewind | Tease + rewind intro segment + overlay + `hard_cut_energy` + whoosh SFX | `chapter-hints.js`, `agents.js` |
| Chronology validator | V25-CHR-01/02/03 on main A-roll pass | `validators/chronology.js`, `recipe-v2.js` |
| brollStrategy enforcement | V25-BROLL-02…05; skip legacy topic check when `match_speech_topics` | `validators/broll-strategy.js`, `recipe-v2.js` |
| directorDrillDown parity | `daySegments`, `brollSyncHints`, `coldOpenSegmentHint` | `director.js` |
| Dead-air enrich | `enrichRecipeSilenceBeatFromDeadAir` from `deadAirHints` (`source: both`) | `dead-air-enrich.js`, `agents.js` |
| CLI help | Documents default `--sort-by creation_time` for ≥2 clips | `cli.js` |
| Fixture | `creationTime` on mini-day clips | `fixtures/batches/mini-day/05a-clip-registry.json` |
| Prompts | V25-CHR/BROLL in critic + fixer; enrich contract in director | `prompts/v2/*.md` |
| SFX rewind | Uses catalog `whoosh` instead of orphan `enrich_rewind_whoosh` | `chapter-hints.js` |

## Quality estimate (multi-clip vlog)

| Stage | Before W4.20 | After W4.20 |
|-------|--------------|-------------|
| Pre-render (recipe + enrich) | ~82% | **~88%** |
| E2E with render | ~75% | **~82%** |

## Remaining gaps (next sprint)

### P0

- Promote V25-CHR-01/02 to `error` (currently warning — recipe passes validation)
- E2E: `full-pipeline-mocked` → `executeRender` on multi-clip fixture
- Pass `teaseSceneId` into `validateMultiClipChronology` to avoid false CHR-01 on director cold opens

### P1

- Render pass toggles: `--skip-creative`, `--skip-subtitles`, `--skip-audio-mix`, `--keep-tmp`
- `run --render` one-shot from inbox to MP4
- Per-output `colorGrade` in schema + render
- Live batch CI job

### P2

- Production LUTs (stubs today)
- `match_cut` vision-based matching
- `fitMode: letterbox` for 9:16→16:9
- CC0 SFX library (stubs today)
- Crossfade + J/L cut conflict resolution in renderer

## Verification

```bash
node --test src/validators/chronology.test.js src/validators/broll-strategy.test.js \
  tests/editorial/dead-air-enrich.test.js tests/editorial/retention-enrich.test.js \
  src/agents/director.test.js src/validators/recipe-v2-validator.test.js
```
