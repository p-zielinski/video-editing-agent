# Speech-aware music ducking

> Last updated: 2026-07-23
> Branch: `main`
> Status: done

## Problem & goal

Predictable mix: **when speech → duck bed; when no speech → bed louder**. Prefer deterministic windows from wordIndexes / output timeline over LLM-guessed `duckingWindows`.

**Done looks like:** enricher fills `audioMixPlan.segments[].duckingWindows` from speech; render falls back if windows absent; tests green; DPDFNet clearly documented as ≠ ducking.

## Scope

- **In scope:** speech-derived `duckingWindows`; enrich after direct + render fallback; optional auto-accept enhancement for speech A-roll; tests; handoff docs
- **Out of scope:** full batch re-render; redesign of sidechaincompress itself; forcing DPDFNet on non-speech clips

## Key files & context

| Area | Path | Role |
|------|------|------|
| Speech ducking | `src/editorial/speech-ducking.js` | derive + enrich windows + speech A-roll accepts |
| Mix | `src/render/audio-mix.js` | `resolveDuckingWindows` + sidechain; render fallback |
| Enrich wiring | `src/pipeline/steps/agents.js` | `enrichRecipeSpeechDucking`, `enrichAudioEnhancementSpeechAccepts` |
| Enhancement | `src/pipeline/steps/audio-enhancement.js` | DPDFNet denoise VO (separate concern) |
| Tests | `tests/editorial/speech-ducking.test.js` | unit coverage |

## Decisions

- 2026-07-23: Primary path = deterministic speech windows; director windows kept if intentional (≥2 windows or non-trivial span)
- 2026-07-23: Speech duck = `musicBed.duckingDb` / −12 dB; gap/shallow = −4 dB
- 2026-07-23: Cap at 16 windows (schema); coarsen by merging speech regions
- 2026-07-23: DPDFNet = source VO denoise for `accept` clips; music ducking = FFmpeg mix
- 2026-07-23: `enrichAudioEnhancementSpeechAccepts` is add-only — never flips director `reject` to `accept` (e.g. unrepairable clipping on essential VO); `reconcileAudioEnhancementDecisions` remains the path for artifact reconciliation

## Progress

- [x] Core `deriveSpeechDuckingWindows` + enricher
- [x] Render fallback when windows missing
- [x] Tests green
- [x] Speech A-roll enhancement auto-accept (add-only; never overwrites existing decisions)
- [x] Docs: PIPELINE enricher list, director prompt note
- [x] Update parent handoff

## Next steps

1. Reviewer verification
2. Optional: re-enrich + re-render mix-only on `51cd206d` to hear bed breathe in gaps

## Blockers / open questions

- None

## Verification

```bash
node --test tests/editorial/speech-ducking.test.js \
  src/pipeline/steps/agents-enricher-order.test.js \
  src/render/audio-mix.test.js
```

## DPDFNet vs mix (short)

| Concern | Mechanism | When |
|---------|-----------|------|
| **DPDFNet** | Denoise/enhance clip WAV (`audio_enhancement`) | `audioEnhancementDecisions[].action === "accept"` |
| **Music ducking** | Bed under VO (`audio-mix.js` sidechain + `duckingWindows`) | Music bed + `duckUnderVoice` |

Speech-aware windows make ducking predictable even when VO has ambient noise that would otherwise keep continuous sidechain engaged in “silence.”
