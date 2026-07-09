# mini-day fixture batch

Minimal **multi-clip day vlog** work directory for pre-render E2E tests (ingest → review, no ffmpeg render).

## Scenario

Two clips from a single vlog day:
- **clip01** (`01_talk.MOV`) — A-roll talk track about visiting a restaurant
- **clip02** (`02_broll.MOV`) — silent B-roll of food and restaurant interior

## Artifact files

| File | Pipeline step | Description |
|------|---------------|-------------|
| `00-manifest.json` | ingest | Batch metadata, user context, input mode |
| `00-scene-catalog.json` | ingest / scene-detect | Clip list and scene boundaries |
| `01-words-clip01.json` | transcribe | Whisper word index for talk clip |
| `01-words-clip02.json` | transcribe | Empty word index for silent B-roll |
| `01b-audio-analysis-clip01.json` | audio_analysis | Per-clip audio features (clip01) |
| `01b-audio-analysis-clip02.json` | audio_analysis | Per-clip audio features (clip02) |
| `02-keyframes-clip01.json` | keyframes | Hybrid-sampled keyframe timestamps for talk clip (placeholder `frames/clip01/*.jpg` paths) |
| `02-keyframes-clip02.json` | keyframes | Scene-cut keyframe timestamps for B-roll clip (placeholder `frames/clip02/*.jpg` paths) |
| `03-vision-clip01.json` | vision | Qwen captions for talk clip (Polish) |
| `03-vision-clip02.json` | vision | Qwen captions for B-roll clip (Polish) |
| `04-objects-clip01.json` | objects | Florence/Qwen object detections (person, face) |
| `04-objects-clip02.json` | objects | Object detections (food, plate) |
| `05-timeline-index.json` | index | Merged timeline: scenes, words, vision, detections (E2E copies pre-merged captions from `03-vision-*`) |
| `05a-clip-registry.json` | clip_profile | Clip roles: `aroll_primary` + `broll_pool` |
| `05b-topic-index.json` | topic_index | Speech topics mapped to matching B-roll scenes |
| `05c-spatial-index.json` | spatial_index | Per-scene anchor bboxes for reframing |
| `05d-audio-index.json` | audio_analysis | Batch audio index (LUFS, beats, dead-air hints) |
| `06-abstract.json` | abstract | L1/L2/L3 summarizer bundle (no OpenAI in E2E) |
| `expected-recipe-v2.json` | direct/review | **E2E validation target** — EditRecipe v2.4 (`tests/e2e/pre-render-pipeline.test.js`) |
| `golden-recipe-v2.json` | review | **Contract test** — EditRecipe v2.4 z retencją, `sfxPlan`, `colorGrade`, `renderStylePresets` |
| `expected-validation.json` | review | Expected validator outcome (0 errors) for `expected-recipe-v2.json` |
| `topic-index.json` | — | **Alias** of `05b-topic-index.json` for contract tests (same content) |
| `spatial-index.json` | — | **Alias** of `05c-spatial-index.json` for contract tests (same content) |

### Artefakty nieobecne w tym fixture (opcjonalne w pełnym pipeline)

| Plik | Krok | Uwaga |
|------|------|-------|
| `01c-meta-commands-*.json` | meta_commands | brak — talk clip nie zawiera voice directives w transkrypcie testowej |
| `03b-twelvelabs-*.json` | twelvelabs | brak — E2E używa stubów / pomija TwelveLabs |
| `04a-faces-*.json` | spatial_index | brak osobnych plików — twarze w `05c-spatial-index.json` |
| `05e-ai-video.json` | ai_video | brak — AI video wyłączone |
| `11-thumbnail-plan.json` / `12-thumbnail-review.json` | thumbnails | brak — poza zakresem pre-render E2E |

### Recipe fixture roles

| File | Version | Used by |
|------|---------|---------|
| `expected-recipe-v2.json` | v2.4 | E2E pre-render pipeline (`validateRecipeV2` golden) |
| `golden-recipe-v2.json` | v2.4 | Contract tests (retention, sfxPlan, renderStylePresets) |

## Usage

```bash
npm run test:e2e
```

Tests copy this directory to a temp work dir, run deterministic pipeline steps (`clip_profile` → `topic_index` → `spatial_index`), and validate the golden recipe with `validateRecipeV2`.
