# Audio Analysis Layer — Implementation Plan

> **Status: DONE** (2026-06-26)  
> Reference: `video-modifier/lib/audio-mix.js`

## Zaimplementowano (skrót)

- Krok pipeline `audio_analysis` po `transcribe` (13 kroków łącznie)
- Artefakty: `01b-audio-analysis-<clipId>.json`, `05d-audio-index.json`, ścieżki `audio/whisper/`, `audio/analysis/`
- Python: `audio_analyze.py` (librosa — beaty/onsets, RMS, cisza, LUFS); fallback **`ffmpeg_astats`** gdy brak librosa (`analysisMode: "ffmpeg_astats"`, puste lub uproszczone beaty)
- Python: `audio_events.py` (PANNs / stub w `--audio-stub`) → `audioEvents[]`, `editorialTags[]`
- `assets/music/catalog.json` + `music-library.js` — dobór bedu; `deriveAudioMixPlanDefaults()` i merge `audioMixPlan` na recipe
- Brief LLM: skrócony `audioIndex` z `cutSuggestions`, `silenceGaps`, `energyPeaks`, `audioEvents`, **`deadAirHints`** (fuzja RMS + przerwy Whisper)
- Walidacja: V21-11 (beat sync), **V21-12** (`music_swell` bez `musicBed`), **V21-13** (`silence_beat` vs cisza)
- Domyślnie live audio/vision/face; `--fast` / `--audio-stub` jako escape
- Testy: unit (schemas, music-library, audio-mix-plan, audio-index-summary, creative-moments), pipeline `audio-analysis`, E2E mini-day z fixture `01b`/`05d`

Szczegóły audytu przed/po: [`AUDIO_ANALYSIS_CRITIQUE.md`](AUDIO_ANALYSIS_CRITIQUE.md).

---

## Goal (oryginalny plan)

Audio analysis beyond Whisper: beats, voice energy, silence/dead air, music bed selection. Populate `audioMixPlan` v2.3 from data. Flip defaults to **max quality** (`--fast` to simplify).

## Pipeline: step 3 `audio_analysis`

After `transcribe`, before `keyframes` (13 steps total).

## Artifacts

- `audio/whisper/<clipId>.mp3` — loudnorm -18 LUFS for Whisper
- `audio/analysis/<clipId>.wav` — for librosa
- `01b-audio-analysis-<clipId>.json` — per clip
- `05d-audio-index.json` — batch rollup

## Schema highlights

Per clip: `voiceLufs`, `energyCurve[]`, `silenceGaps[]`, `beats[]`, `musicBedRecommendation`, `cutSuggestions[]`, **`audioEvents[]`**, **`editorialTags[]`**

Batch index: clips summary + `batchSummary` + `musicLibrary` catalog + per-clip `editorialTags`

## Python

`python/audio_analyze.py` — librosa beats/onsets, RMS energy, silence; fallback ffmpeg astats

`python/audio_events.py` — **AudioSet event tagging** (PANNs CNN14 SED; stub w `--audio-stub`)

## Music

`assets/music/catalog.json` + `src/editorial/music-library.js` — mood/BPM picker from video-modifier patterns

## Defaults flip

| Option | New default | Escape |
|--------|-------------|--------|
| vision | live | `--vision-stub`, `--fast` |
| face | live | `--face-stub`, `--fast` |
| objects | live | `--objects-stub` |
| audio | live | `--audio-stub`, `--fast` |

## Director

`audioIndex` in brief, `deriveAudioMixPlanDefaults()`, post-merge audioMixPlan on recipe

## Tests

Unit: schemas, music-library, audio-mix-plan, measure-loudness  
Pipeline: audio-analysis step, artifact-deps  
E2E: mini-day fixtures with 01b/05d; full-pipeline mocked (12 testów E2E łącznie)
