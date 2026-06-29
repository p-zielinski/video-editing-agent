# W4.18 — Recipe enrich polish + montage E2E

> Last updated: 2026-06-29
> Status: in progress

## Tasks

| ID | Task | Agent | Status |
|----|------|-------|--------|
| W4.18-1 | `enrichRecipeChapterCards` | A | ✅ |
| W4.18-2 | spatialRef on enrich zoom beats | B | |
| W4.18-3 | Golden `enrich_beat_*` fixture | A | |
| W4.18-4 | Prompts enrich contract | C | |
| W4.18-5 | V24-06 trim in sfx enrich | C | |
| W4.18-6 | V22-VLOG-05 fixer-required | C | |
| W4.18-7 | V24-06 in critic.md | C | |
| W4.18-8 | E2E direct→enrich→render | D | ✅ |
| W4.18-9 | FORMATY sync | D | ✅ |
| W4.18-10 | Cold-open segment hint | D | ✅ |

Target: flow 86% → 92%+

## W4.18-D deliverables

- `tests/e2e/render-vlog-retention-pipeline.test.js` — mini-day → enrich retention + chapter cards → `executeRender`
- `buildColdOpenSegmentHint()` → `brief.coldOpenSegmentHint` w `director.js`
- `docs/FORMATY_AI_I_GOTOWOSC_MONTAZU.md` §6.3 — enrich post-direct, V24-06

## Verification

```bash
node --test tests/editorial/retention-enrich.test.js src/agents/director.test.js
node --test tests/e2e/render-vlog-retention-pipeline.test.js
```
