# EditRecipe v2.2 — Shorts Retention Grammar: Critique

> Data: 2026-06-26  
> Plan: `docs/SHORTS_RETENTION_V22_PLAN.md`  
> Werdykt: **Resolved (P0–P1)** — scaffold semantics fixed 2026-06-26

## Executive summary

| Area | Status | Risk |
|------|--------|------|
| 6 graphics techniques | ✅ Good | Low |
| Pack + schema v2.2 | ✅ Good | Low |
| `shorts-retention.js` | ✅ **Resolved** — enabled gating | Low |
| V22 validators | ✅ **Resolved** — beat-only cadence, V22-07 | Low |
| Director integration | ✅ **Resolved** — gated on 9:16 / opt-in | Low |
| Backward compat v2.0/v2.1 | ✅ **Resolved** — opt-in only | Low |

## Critical issues — RESOLVED

1. **`DEFAULT_SHORTS_RETENTION_PROFILE.enabled: true`** — **RESOLVED**: default `false`; `mergeShortsRetentionProfile` strips default `enabled` before merge; `shouldRunShortsRetentionValidation` gates V22.
2. **Beat targets under-shoot `minRetentionBeats`** — **RESOLVED**: `computeRetentionBeatTargets` fills to min via even spacing fallback.
3. **v2.0/v2.1 short outputs** get V22 without opt-in — **RESOLVED**: legacy recipes require explicit `enabled: true` or context.

## Important issues — RESOLVED

4. V22-03 counts `techniqueId` not `retentionRole: beat` — **RESOLVED**: `isRetentionBeatMoment` primary on role; technique fallback only when role unset.
5. V22-04 cadence uses all moments — **RESOLVED**: beat-only anchors from `hookWindowSec`.
6. `maxHookOverlayDurationSec` and overlay budget — **RESOLVED**: V22-07 added.
7. Beat targets use source duration — **RESOLVED**: `resolveShortOutputDurationSec` + director uses `shortsMaxDurationSec`.
8. No director tests — **RESOLVED**: `director.test.js` retention injection matrix.
9. `hook_number` / `cta` schema — **RESOLVED**: `hook_number` in `TextOverlayStyleSchema`; `cta` documented on overlays vs `payoff` on moments.

## Prioritized fix list

| P | Fix | Status |
|---|-----|--------|
| P0 | Fix `enabled` gating — default off | ✅ |
| P0 | Gate `validateShortsRetention` on same predicate | ✅ |
| P1 | Fix `computeRetentionBeatTargets` for minBeats + short duration | ✅ |
| P1 | Align `isRetentionBeatMoment` with `retentionRole: beat` | ✅ |
| P1 | Add V22-03 tests + enabled matrix + director brief test | ✅ |
| P2 | V22-07 overlay budget + maxHookOverlayDurationSec | ✅ |
| P2 | Unify enums hook_number, cta | ✅ |
| P2 | Extend V22-05 to all hook-class techniques | ✅ |

## Remaining nice-to-haves

- Render ffmpeg mapping for `hook_large` / `hook_number` styles
- Auto-selekcja hook clip z abstract (LLM-only w director)
- JSON schema export regen for `hook_number` if consumed externally
- A/B test harness for retention cadence on platforms
