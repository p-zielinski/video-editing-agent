# Director salvage & audio enhancement

> Last updated: 2026-07-17
> Status: done

## Problem & goal

Director should critically assess footage and propose salvage strategies (especially voice-over proposal without TTS). Pipeline should measure dialogue audio quality and optionally denoise accepted clips, then re-normalize LUFS for consistent dialogue levels.

## Scope

- **In scope:** `audioQuality` in `audio_analysis`, L3 `editorialAssessment`, recipe `editorialAssessment` / `salvagePlan` / `audioEnhancementDecisions`, `audio_enhancement` step, render enhanced WAV, validators SALVAGE-* / AUD-QUAL-*, docs/tests.
- **Out of scope:** TTS generation, paid API provider implementation, re-transcription after enhancement.

## Key files

| Area | Path | Role |
|------|------|------|
| Quality heuristics | `python/audio_quality.py` | SNR, wind, grade |
| JS merge | `src/lib/audio-quality.js` | PANNs wind + candidates |
| Summarizer L3 | `src/agents/summarizer.js`, `prompts/v2/summarizer.md` | `editorialAssessment` |
| Director | `src/agents/director.js`, `prompts/v2/director.md` | salvage brief + output fields |
| Enhancement step | `src/pipeline/steps/audio-enhancement.js` | denoise + LUFS |
| Render | `src/render/resolve-render-context.js`, `enrich-render-edl.js` | enhanced audio paths |
| Validators | `src/validators/recipe-v2.js` | SALVAGE-*, AUD-QUAL-* |

## Decisions

- 2026-07-18: DeepFilterNet fail hard (bez cichego ffmpeg fallback); recovery plan `17-recovery-plan.json` + execution ledger `00-execution-state.json`.
- 2026-07-17: VO MVP = proposal only (`needsHumanReview`), no TTS.
- 2026-07-17: Enhancement after `direct`, before `review` (aiHookDecision pattern).
- 2026-07-17: Default provider DeepFilterNet; jawny ffmpeg/stub dla CI/dev.

## Progress

- [x] audioQuality in audio_analysis
- [x] L3 editorialAssessment
- [x] EditRecipe v2.5 salvage fields
- [x] Director prompt + brief
- [x] audio_enhancement step
- [x] Render enhanced WAV
- [x] Validators + critic/fixer prompts
- [x] Tests + PIPELINE.md

## Verification

```bash
npm test -- src/lib/audio-quality.test.js src/pipeline/steps/audio-enhancement.test.js src/lib/audio-enhancement/normalize.test.js src/agents/summarizer.test.js
```
