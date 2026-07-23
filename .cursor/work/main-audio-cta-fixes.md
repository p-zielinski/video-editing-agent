# Main audio, clip16 denoise reconcile, CTA fixes

> Last updated: 2026-07-20
> Branch: `main`
> Status: done

## Problem & goal

1. Main ending too quiet (stacked silence_beat + music_drop + clip40 unenhanced).
2. clip16 noise: dpdfnet ran but decisions say reject; hum not wind.
3. enrich_cta_001 uses L3 summary and overlaps payoff/subs.

## Scope

- Payoff enrich + sanitize audio/CTA
- Enhancement reconcile + protect index
- Closure CTA short templates
- Batch 51cd206d patch + re-render

## Key files & context

| Area | Path | Role |
|------|------|------|
| Payoff enrich | `src/editorial/payoff-enrich.js` | Skip silence_beat near music_drop / low voiceLufs |
| Sanitize | `src/editorial/recipe-hard-error-sanitize.js` | Stacked ducks, tail volume, source windows, CTA |
| Enhancement | `src/pipeline/steps/audio-enhancement.js` | `reconcileAudioEnhancementDecisions`, index protect |
| CTA enrich | `src/editorial/closure-enrich.js` | Polish short CTA, skip tail conflicts |

## Decisions

- 2026-07-20: silence_beat skipped (not retargeted) when stacked with music_drop ±0.5s or voiceLufs < -30.
- 2026-07-20: sourceVolumeDb < -3 clamped to 0 in sanitize (enhancement uses positive WAV gains).
- 2026-07-20: CTA text fixed to `"Subskrybuj"` — never L3 sessionSummary.
- 2026-07-20: reconcile flips reject→accept when index has succeeded/stubbed manifest; protects index from empty overwrite.
- 2026-07-20: batch work dir was partially wiped mid-session; restored missing artifacts + enhanced WAVs from `output/.work/old_51cd206d`.

## Progress

- [x] A: end audio (payoff-enrich + sanitizeStackedPayoffAudioDucks, sanitizeTailSourceVolumeDb, sanitizeSegmentSourceWindows)
- [x] B: enhancement reconcile (`reconcileAudioEnhancementDecisions`, index protect on empty accepted)
- [x] C: CTA (closure-enrich + sanitizeNarrativeCtaOverlays)
- [x] D: batch 51cd206d patch + enhance clip40 + render
- [x] Reviewer APPROVED (acceptance criteria 1–5)

## Next steps

None for this plan. Optional follow-up (out of scope): fix `CREATIVE_FALLBACK` broken `zoompan` expr on `hook_visual_punch`.

## Blockers / open questions

None.

## Verification

```bash
node --test tests/editorial/payoff-enrich.test.js \
  tests/editorial/closure-enrich.test.js \
  tests/editorial/recipe-hard-error-sanitize.test.js \
  src/pipeline/steps/audio-enhancement.test.js
# 48 pass / 0 fail

node src/cli.js render --batch-id 51cd206d --force --render-profile production
# main_16x9_16x9.mp4 (~150s), short_9x16_9x16.mp4 (30s)
```

### Reviewer checklist (2026-07-20)

1. **silence_beat vs music_drop** — PASS (0 silence_beat; music_drop only)
2. **sourceVolumeDb / segment windows** — PASS (main_005/006 vol 0; windows match)
3. **enhancement reconcile** — PASS (clip16 accept + WAV; clip40 accept + WAV)
4. **CTA** — PASS (no enrich_cta_*; resolveCtaText = Subskrybuj)
5. **Renders** — PASS
