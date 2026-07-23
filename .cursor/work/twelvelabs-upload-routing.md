# TwelveLabs upload routing (proxy + short GPT + chunks)

> Last updated: 2026-07-18
> Branch: `main`
> Status: done

## Problem & goal

TwelveLabs upload fails on large iPhone 4K files and rejects clips &lt;4s. Done: short GPT frame analysis (mini quota), 720p proxy + stream upload, temporal chunks with merged insights.

## Scope

- **In scope:** multimodal chat + quota, upload prep, short GPT, chunking, docs/tests
- **Out of scope:** TwelveLabs Assets multipart API

## Key files & context

| Area | Path | Role |
|------|------|------|
| Quota multimodal | `src/agents/openai-client.js`, `openai-model-router.js` | `chatJsonMultimodal` |
| Short GPT | `src/lib/twelvelabs-short-analysis.js` | frames → editorial |
| Upload prep | `src/lib/twelvelabs-upload-prep.js` | proxy + chunks |
| Step | `src/pipeline/steps/twelvelabs.js` | routing |
| Client | `src/lib/twelvelabs-client.js` | stream upload + merge |

## Decisions

- 2026-07-18: short model = mini pool (`OPENAI_MODEL_TWELVELABS_SHORT` / `OPENAI_MODEL_MINI`)
- 2026-07-18: Wave A uses `TWELVELABS_API_KEY` only (not OpenAI key) for live TL
- 2026-07-18: no Assets multipart — proxy + temporal chunks

## Progress

- [x] Quota multimodal helper
- [x] Upload prep + stream
- [x] Short-clip GPT branch
- [x] Temporal chunks
- [x] Contracts / docs / tests

## Next steps

1. Optional follow-up: TwelveLabs Assets multipart API
2. Resume batch `51cd206d` with fixed key to validate live path

## Verification

```bash
node --test src/agents/openai-client.test.js \
  src/lib/twelvelabs-upload-prep.test.js \
  src/lib/twelvelabs-short-analysis.test.js \
  src/lib/twelvelabs-client.test.js \
  src/pipeline/steps/twelvelabs.test.js \
  src/lib/config-fingerprint.test.js \
  src/lib/clip-artifact-cache.test.js
```
