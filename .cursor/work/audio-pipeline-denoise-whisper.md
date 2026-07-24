# Audio pipeline: denoise→Whisper + director/context fixes

> Last updated: 2026-07-24
> Status: done

## Problem & goal

Fix audio desync/cutoff, clip16 starvation, lost director context, and rebuild audio path: denoise-all before Whisper + speech/ambient ducking in render.

## Scope

- **In scope:** Phases 1–4 + wipe/restart instructions
- **Out of scope:** face tracking, blur 9:16, cold-open LLM redesign

## Progress

- [x] Faza 1 — render/audio acute fixes
- [x] Faza 2 — context hydration + long-scene caps
- [x] Faza 3 — denoise before Whisper
- [x] Faza 4 — speech↔ambient duck
- [x] Faza 5–6 — verify + wipe commands

## Pipeline order (now)

```
ingest → audio_enhancement → transcribe → meta_commands → audio_analysis →
keyframes → twelvelabs → vision → objects → index → clip_profile → abstract →
topic_index → spatial_index → ai_video → direct → review → thumbnails → publish
```

`PIPELINE_ANALYSIS_VERSION = "2"`

## Decisions

- 2026-07-24: Enhance-all before Whisper (accept/reject is render gate only).
- 2026-07-24: Source duck = enhanced during speech / original ambient in gaps (~60 ms); separate from music-bed ducking.
- 2026-07-24: Long scenes use `sampleWordsAcrossScene` (begin/mid/end), not head-only slice.
- 2026-07-24: Resume hydrates `userContext`/`batchContext` from manifest when CLI context empty.

## Verification (2026-07-24)

```bash
# 300 pass / 0 fail (aggregated phase suites)
node --test src/render/audio-mix.test.js src/render/audio-jlcut.test.js \
  src/lib/build-output-timeline.test.js src/validators/recipe-consistency.test.js \
  src/pipeline/steps/audio-enhancement.test.js src/pipeline/orchestrator.test.js \
  src/agents/director.test.js src/lib/word-sampling.test.js \
  src/lib/abstraction-chunking.test.js src/render/audio-source-duck.test.js \
  src/render/enrich-render-edl.test.js src/render/ffmpeg-segment.test.js \
  src/pipeline/work-paths.test.js src/pipeline/artifact-deps.test.js \
  src/lib/extract-audio.test.js
# + tests/editorial/speech-ducking.test.js → 10 pass
```

## Wipe + restart batch `51cd206d`

### Keep (analiza wideo)

- `00-manifest.json`, `00-scene-catalog.json`
- `02-keyframes-*.json`, `03-vision-*.json`, `03b-twelvelabs-*.json`
- `04-objects-*.json`, `04a-faces-*.json`
- `frames/`, `twelvelabs-*/`, `generated/` (jeśli nie zależą od recipe)

### Delete (audio + index/abstract zależne od words + director+)

Abstract **musi** polecieć: stare L1 było na obciętym transcriptcie clip16.

```bash
cd /Users/piotr/Documents/GitHub/video-editing-agent/output/.work/51cd206d

# Audio / enhancement / Whisper
rm -f 01-words-*.json 01b-*.json 01c-*.json \
  07a-audio-enhancement-*.json 07b-audio-enhancement-index.json
rm -rf enhanced-audio audio/whisper audio/enhancement audio/analysis

# Index / abstract / topic / spatial / music (zależą od świeżych words)
rm -f 05-timeline-index.json 05b-clip-registry.json 05c-*.json 05d-*.json 05e-*.json \
  05f-music-selection.json \
  06-abstract*.json

# Director + review + publish + renders
rm -f 07-edit-recipe-draft.json 08-review.json 08b-consistency-audit.json \
  09-edit-recipe-final.json 10-batch-quality-report.json \
  11-thumbnail-plan.json 12-thumbnail-review.json \
  13-render-manifest.json 13b-montage-fidelity.json \
  14-recipe-provenance.json 15-publish-package-*.json \
  16-gpt-usage.json 00-execution-state.json
rm -rf renders

# LLM cache: director/review + summarizer (L1/L2/L3) — NIE reuse
rm -f llm-cache/super_director__* llm-cache/segment_director__* \
  llm-cache/drill_down__* llm-cache/critic__* llm-cache/fixer__* \
  llm-cache/fixer_escalation__* llm-cache/super_critic__* \
  llm-cache/music_curator__* llm-cache/thumbnail_* \
  llm-cache/abstract__*
```

### Run (kontekst obowiązkowy; bez `--reuse-llm-cache`)

Manifest już ma właściwy `userContext` — hydracja zadziała przy pustym CLI — ale JSON jest bezpieczniejszy (przywraca też `inputMode`):

```bash
cd /Users/piotr/Documents/GitHub/video-editing-agent

node src/cli.js run --batch-id 51cd206d --from-step audio_enhancement \
  --context '{"notes":"wyjazd w góry, na dzień przed moimi 30stymi urodzinami, próba podejścia do tego jak do rozliczenia się z lat 20stych i próba zyczenia sobie lepszych lat 30stych, lata 20 to moze nie czas porazek ale z pewnością niewykorzystanych szans","inputMode":"multi_clip_day"}'
```

Keyframe/vision/objects zostaną pominięte (artefakty istnieją). Enhancement → Whisper → … → abstract → direct → review.

Szybki check draftu przed pełnym review:

```bash
node src/cli.js run --batch-id 51cd206d --from-step audio_enhancement --to-step direct \
  --context '{"notes":"…","inputMode":"multi_clip_day"}'
# sprawdź: 07-edit-recipe-draft.json → batchContext.notes + inputMode multi_clip_day
# oraz ile sekund clip16 (IMG_1940) jest w main timeline
```

Render:

```bash
node src/cli.js render --batch-id 51cd206d --render-profile production --force
```

## Next steps (opcjonalne follow-upy)

- Pełny re-run batcha (koszt: enhance-all 41 klipów + Whisper)
- Spot-check: bed przez cały main, A≈V duration, clip16 ≫ 3 s, duck speech/ambient
