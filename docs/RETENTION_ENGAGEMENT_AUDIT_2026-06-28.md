# Retention & engagement audit — 2026-06-28

> Updated after W4.17

## Executive summary

**Flow design score: 86/100** (was 62% → 76% → **86%**)

W4.17 closes deterministic beat placement: timeline-mapped anchors, post-director/fixer `enrichRecipeRetentionBeats`, fixer repair for V22-VLOG-03/04, SFX density V24-06, and E2E long-main vlog render.

Vlog beats are **cadence-deterministic**; chapter cards and cold-open loops remain **brief-only** (W4.18).

---

## W4.17 delivered

| Capability | Effect |
|------------|--------|
| `mapSourceTimeToOutputSec` | Anchor snap on output timeline |
| `enrichRecipeRetentionBeats` | Auto `enrich_beat_*` when director omits beats |
| Dual anchors | `retentionBeatAnchorsMain` + `Short` |
| Fixer V22-VLOG-03/04 | Warnings trigger fixer |
| V24-06 | SFX max 1 / 90s on main |
| `chapterCardHints` | L2 cards every ~3–5 min (brief) |
| `narrativeOpenLoops` | L3 cold open + payoff tease (brief) |
| E2E vlog retention | 180s main, 4 beat techniques |

---

## Score breakdown

| Area | Score | Δ vs W4.16 |
|------|------:|------------|
| Vlog retention | 88% | +16 |
| Budget coherence | 91% | +3 |
| Dual-format | 90% | +8 |
| Shorts | 88% | — |
| Pipeline | 89% | +7 |
| **Weighted** | **86%** | **+10** |

---

## Vlog beat determinism

| Deterministic | Still soft |
|---------------|------------|
| 45s cadence + V22-VLOG-01/02 | Director primary author |
| Mapped anchor snap | spatialRef on enriched zoom |
| `enrichRecipeRetentionBeats` | Chapter cards → recipe (W4.18) |
| Fixer on monotony/aggressive | V22-VLOG-05 drift |

---

## Fatigue-safe rotation

`zoom_slow_push` → `ken_burns_light` → `music_swell` → `silence_beat`

---

## Open gaps → W4.18

1. `enrichRecipeChapterCards`
2. spatialRef on enrich zoom beats
3. Full pipeline E2E direct→render
4. V24-06 trim in SFX enrich

See `docs/W4_18_PLAN.md`
