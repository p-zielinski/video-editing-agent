# Retention & engagement audit — 2026-06-28

> Updated post-W4.18 (2026-06-29)

## Executive summary

**Flow design score: 91/100** (62% → 76% → 86% → **91%**)

W4.18 closes the brief→recipe gap: chapter cards, spatialRef on enrich beats, SFX trim, full enrich pipeline E2E.

**Vlog cadence is production-ready** when `audioIndex` is real and `vlogRetentionProfile.enabled`.

---

## W4.18 delivered

| Capability | Effect |
|------------|--------|
| `enrichRecipeChapterCards` | L2 chapter_card overlays main ≥180s |
| `resolveSpatialRefForBeat` | spatialRef on enrich zoom/ken burns |
| `trimSfxPlanToDensityCap` | V24-06 enforced in enrich |
| `applyDeterministicRecipeEnrichers` | Central post-direct + post-fixer hook |
| E2E enrich→render | `render-vlog-retention-pipeline.test.js` |
| V22-VLOG-05 fixer | Beat target drift repairable |
| `enrichRecipeColdOpenSegment` | Prepend tease (rewind W4.19) |

---

## Score breakdown

| Area | Score |
|------|------:|
| Vlog retention | 92% |
| Budget coherence | 93% |
| Dual-format | 90% |
| Pipeline | 91% |
| **Weighted** | **91%** |

---

## Determinism

| Deterministic | Still soft |
|---------------|------------|
| enrich beats + chapters + SFX trim | Director primary beats |
| V22-VLOG + fixer loop | Cold-open rewind |
| Mapped anchors + spatialRef | Full LLM pipeline E2E |
| Render all beat techniques | `--fast` without audio peaks |

---

## Open → W4.19

See `docs/W4_19_PLAN.md`
