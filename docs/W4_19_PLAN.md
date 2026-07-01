# W4.19 — Full pipeline E2E + cold-open rewind

> Last updated: 2026-06-29
> Status: planned
> Prerequisite: W4.18 done (flow 91%)

Target: **91% → 95%+**

## P0

| ID | Task |
|----|------|
| W4.19-1 | Cold-open rewind segment + audio bridge (not just prepend tease) |
| W4.19-2 | `directorDrillDown` parity: chapterCardHints, coldOpenSegmentHint |
| W4.19-3 | E2E `run` mock LLM → enrich → render |
| W4.19-4 | Chronology validator (`sortIndex` vs timeline) |
| W4.19-5 | `deadAirMontageHints` → `silence_beat` enrich |

## P1

| ID | Task |
|----|------|
| W4.19-6 | Live batch checklist in CI |
| W4.19-7 | CC0 SFX production swap (optional) |

Reference: `docs/W4_19_MULTI_CLIP_AND_ENRICH_AUDIT.md` if present
