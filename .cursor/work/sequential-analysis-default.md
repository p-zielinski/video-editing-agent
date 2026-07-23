# Sequential analysis by default

> Last updated: 2026-07-18
> Status: done

## Problem & goal

Default analysis phase loaded Qwen + Florence in parallel (`Promise.all`) and mixed step types per clip, causing OOM/hangs on Mac even with concurrency=1. Done = one step type at a time by default; opt-in env flags restore old waves.

## Scope

- **In scope:** `CLIP_CONCURRENCY` default 1, sequential `runAnalysisPhase`, env flags, docs, tests
- **Out of scope:** batch `51cd206d` resume (user runs manually)

## Key files

| Area | Path | Role |
|------|------|------|
| Defaults | `src/lib/clip-concurrency.js` | `CLIP_CONCURRENCY` default 1; parallel env helpers |
| Orchestration | `src/pipeline/analysis-phase.js` | Sequential default; wave mode opt-in |
| Tests | `src/pipeline/analysis-phase.test.js` | vision→objects order, no overlap |
| Docs | `docs/PIPELINE.md`, `.env.example` | Updated concurrency table |

## Decisions

- 2026-07-18: `ANALYSIS_PARALLEL_CLIPS=1` restores Wave A; `ANALYSIS_PARALLEL_GPU_STEPS=1` restores vision∥objects; both needed for full legacy behavior.

## Progress

- [x] CLIP_CONCURRENCY default 1 + test
- [x] Sequential runAnalysisPhase
- [x] Docs + .env
- [x] analysis-phase tests

## Verification

```bash
node --test src/lib/clip-concurrency.test.js src/pipeline/analysis-phase.test.js
```

Resume batch:

```bash
npm run full -- --batch-id 51cd206d --from-step vision --context "…"
```
