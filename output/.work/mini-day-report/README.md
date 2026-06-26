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
| `03-vision-clip01.json` | vision | Qwen captions for talk clip (Polish) |
| `03-vision-clip02.json` | vision | Qwen captions for B-roll clip (Polish) |
| `04-objects-clip01.json` | objects | Florence/Qwen object detections (person, face) |
| `04-objects-clip02.json` | objects | Object detections (food, plate) |
| `05-timeline-index.json` | index | Merged timeline: scenes, words, vision, detections (E2E copies pre-merged captions from `03-vision-*`) |
| `06-abstract.json` | abstract | L1/L2/L3 summarizer bundle (no OpenAI in E2E) |
| `05a-clip-registry.json` | clip_profile | Clip roles: `aroll_primary` + `broll_pool` |
| `05b-topic-index.json` | topic_index | Speech topics mapped to matching B-roll scenes |
| `05c-spatial-index.json` | spatial_index | Per-scene anchor bboxes for reframing |
| `expected-recipe-v2.json` | direct/review | **E2E validation target** — EditRecipe v2.0 exercised by `tests/e2e/pre-render-pipeline.test.js` |
| `golden-recipe-v2.json` | review | **Contract test** — EditRecipe v2.2 with shorts retention (`tests/contracts/golden-recipe-v2.test.js`) |
| `expected-validation.json` | review | Expected validator outcome (0 errors) for `expected-recipe-v2.json` |
| `topic-index.json` | — | **Alias** of `05b-topic-index.json` for contract tests (same content) |
| `spatial-index.json` | — | **Alias** of `05c-spatial-index.json` for contract tests (same content) |

### Recipe fixture roles

| File | Version | Used by |
|------|---------|---------|
| `expected-recipe-v2.json` | v2.0 | E2E pre-render pipeline (`validateRecipeV2` golden) |
| `golden-recipe-v2.json` | v2.2 | Contract tests (retention profile, v22 validators) |

## Usage

```bash
npm run test:e2e
```

Tests copy this directory to a temp work dir, run deterministic pipeline steps (`clip_profile` → `topic_index` → `spatial_index`), and validate the golden recipe with `validateRecipeV2`.
