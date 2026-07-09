# voiceover-day fixture batch

Minimal **voice-over vlog** work directory for contract and render E2E tests (B-roll video + separate narration audio).

## Scenario

Three clips from a vlog recorded without on-camera speech:

- **clip01** (`01_broll_city.MOV`) — silent B-roll of city streets
- **clip02** (`02_broll_food.MOV`) — silent B-roll of food and café interior
- **clip03** (`03_narration.wav`) — audio-only narration track (`mediaType: audio_only`, `clipRole: narration_track`)

The golden recipe pairs B-roll video with narration audio via `audioPolicy: from_audio_ref` and word-by-word subtitles from `clip03`.

## Artifact files

| File | Pipeline step | Description |
|------|---------------|-------------|
| `00-manifest.json` | ingest | Batch metadata, user context, input mode |
| `00-scene-catalog.json` | ingest / scene-detect | Three clips (2× video B-roll + 1× audio narration) |
| `01-words-clip01.json` | transcribe | Empty word index (silent B-roll) |
| `01-words-clip02.json` | transcribe | Empty word index (silent B-roll) |
| `01-words-clip03.json` | transcribe | Whisper word index for narration clip |
| `05-timeline-index.json` | index | Minimal merged timeline (scenes + narration words) |
| `05a-clip-registry.json` | clip_profile | `broll_pool` × 2 + `narration_track` |
| `golden-recipe-v2.json` | review | EditRecipe v2.4 with `from_audio_ref` B-roll segments |

### Artefakty nieobecne (minimalny fixture render)

Brak m.in.: `01b-audio-analysis-*`, `01c-meta-commands-*`, `02-keyframes-*`, `03-vision-*`, `03b-twelvelabs-*`, `04-objects-*`, `04a-faces-*`, `05b-topic-index.json`, `05c-spatial-index.json`, `05d-audio-index.json`, `06-abstract.json`. Render E2E generuje lavfi wideo i sine WAV zamiast pełnej analizy.

## Usage

```bash
# Contract: schema + validator
npm test -- tests/contracts/golden-recipe-v2.test.js

# Render E2E (requires ffmpeg)
npm test -- tests/e2e/render-voiceover.test.js
```

Render tests copy this directory to a temp work dir, generate lavfi B-roll MP4s and a sine WAV narration file, then render outputs from the golden recipe.

### E2E coverage (`tests/e2e/render-voiceover.test.js`)

| Test | Output | Asserts |
|------|--------|---------|
| dry-run EDL | — | `seg_vo_01` / `seg_vo_02`: B-roll video path ≠ narration WAV; `audioPolicy: from_audio_ref` |
| render MP4 | `horizontal_main` | Output exists; duration ≈ EDL; no fatal warnings |
| render MP4 | `short_9x16` | 1080×1920 vertical dimensions; duration ≈ EDL |
| segmentWarnings | `horizontal_main` | `broll_av_desync` on `seg_vo_01` (recipe video 12s vs audio 10s — intentional mismatch) |

The `broll_av_desync` warning confirms the renderer surfaces A/V length mismatches on cross-clip VO segments without failing the render.
