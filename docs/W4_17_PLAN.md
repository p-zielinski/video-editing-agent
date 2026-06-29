# W4.17 — Deterministic retention + critic coherence

> Last updated: 2026-06-28
> Status: **done**

## Completed

| ID | Task |
|----|------|
| W4.17-1 | Critic v2.4 + per-output budget ✅ |
| W4.17-2 | `mapSourceTimeToOutputSec` + mapped anchors ✅ |
| W4.17-3 | `enrichRecipeRetentionBeats` post-director/fixer ✅ |
| W4.17-4 | Dual `retentionBeatAnchorsMain` / `Short` ✅ |
| W4.17-5 | V22-VLOG docs aligned ✅ |
| W4.17-6 | E2E `render-vlog-retention.test.js` ✅ |
| W4.17-7 | Fixer V22-VLOG-03/04 ✅ |
| W4.17-8 | V24-06 SFX density cap ✅ |
| W4.17-9 | `chapterCardHints` from L2 ✅ |
| W4.17-10 | `narrativeOpenLoops` from L3 ✅ |

## Verification (2026-06-28)

| Command | pass | fail | skip |
|---------|-----:|-----:|-----:|
| `npm test` | 852 | 0 | 2 |
| `npm run test:e2e` | 46 | 0 | 1 |
| `render-vlog-retention.test.js` | 1 | 0 | 0 |

## Flow design score: **86%** (was 76%)

See `docs/RETENTION_ENGAGEMENT_AUDIT_2026-06-28.md`

## Next: `docs/W4_18_PLAN.md`
