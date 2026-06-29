# W4.15 — Retention polish + pipeline enrichment

> Last updated: 2026-06-28
> Status: done (verification 2026-06-28)

## Goal

Close W4.14 pending items + design retention beats every 30–60s without fatigue.

## Tasks

| ID | Task | Agent |
|----|------|-------|
| W4.15-1 | Post-director `sfxPlan` merge from audio analysis | A ✅ |
| W4.15-2 | `match_cut` best-effort + V21-15 partial crossfade validator | B | ✅ |
| W4.15-3 | E2E `dip_to_black` / `zoom_punch_out` + subtitle realign after beat snap | C — **partial** (subtitle realign + E2E techniques ✅) |
| W4.15-4 | Retention cadence enricher (30–60s `retention_beat` hints) | D | **done** |
| W4.15-5 | Independent flow + engagement audit | E | ✅ |
| W4.15-6 | Test verification | F | ✅ |

## Output docs

- `docs/RETENTION_ENGAGEMENT_AUDIT_2026-06-28.md`
- `docs/W4_15_PLAN.md` (this file, updated on completion)

## W4.15-4 (Task D) — delivered

- `DEFAULT_VLOG_RETENTION_PROFILE` (45s ±8s) + `computeRetentionBeatTargets(..., { mode })`
- Director brief: `vlogRetentionProfile`, `retentionTechniqueRotation`, `retentionMomentSuggestions`
- `suggestRetentionMoments` — deterministic brief hints only
- Docs: `docs/RETENTION_ENGAGEMENT_AUDIT_2026-06-28.md`

## Verification

```bash
npm test && npm run test:e2e
```

## Verification (2026-06-28, agent F)

### Test runs

| Command | tests | suites | pass | fail | skip | duration |
|---------|------:|-------:|-----:|-----:|-----:|----------|
| `npm test` | 805 | 102 | 803 | 0 | 2 | ~1098 s |
| `npm run test:e2e` | 46 | 23 | 45 | 0 | 1 | ~544 s |

**Skipped (expected):** `OPENAI_API_KEY not set` ingest→index E2E; optional PANNs preflight (`librosa/soundfile`).

**Failures:** none. No code fixes required for this verification pass.

### `UNSUPPORTED_TECHNIQUES`

- No `UNSUPPORTED_TECHNIQUES` constant remains under `src/` (removed from `ffmpeg-creative.js`).
- Only historical mention: `docs/W4_13_PLAN.md`.
- Render uses per-technique `TECHNIQUE_UNSUPPORTED` warnings in tests; `match_cut` / `dip_to_black` / `zoom_punch_out` covered by unit + render E2E.

### Deliverable spot-check

| Artifact | Location |
|----------|----------|
| `enrichRecipeSfxPlan` | `src/editorial/sfx-plan.js`; wired in `src/pipeline/steps/agents.js` |
| `match_cut` render path | `src/render/technique-to-ffmpeg.js`, `techniques/edit/match_cut.json` |
| V21-15 partial crossfade | `src/validators/creative-moments.js` (`code: "V21-15"`) |
| Vlog retention profile | `DEFAULT_VLOG_RETENTION_PROFILE` in `src/editorial/shorts-retention.js`; director tests |
| Engagement audit doc | `docs/RETENTION_ENGAGEMENT_AUDIT_2026-06-28.md` |

### W4.15-6 status

**Done** — full unit + e2e green on 2026-06-28.
