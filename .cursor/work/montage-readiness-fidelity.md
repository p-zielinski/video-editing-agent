# Montage readiness + fidelity logs

> Last updated: 2026-07-23
> Branch: (local)
> Status: done (code)
> Batch target: `51cd206d` (ops `--force` re-run still pending)

## Problem & goal

1. Is the current director→recipe→render stack actually a good montage recipe, including for longer/larger batches?
2. Fix remaining bugs/gaps before a forced re-run.
3. Add montage fidelity logs to debug recipe vs rendered output mismatches.

**Done for code:** stopwords, `13b-montage-fidelity.json`, brief soft guard, docs.

## Scope

- **In scope:** Polish discourse stopwords; `13b-montage-fidelity.json`; brief-metrics soft warn; docs + force re-run handoff.
- **Out of scope:** Live OpenAI re-run; raising drill-down cap; hand-editing batch recipes.

## Key files & context

| Area | Path | Role |
|------|------|------|
| Topics | `src/pipeline/steps/topic-index.js` | Expanded `STOP_WORDS` + exported `tokenize` |
| Fidelity | `src/render/montage-fidelity.js` | build / merge / CLI warn helpers |
| Paths | `src/pipeline/work-paths.js` | `ARTIFACTS.montageFidelity` |
| Render | `src/render/execute-render.js` | write fidelity after each output |
| Creative | `src/render/ffmpeg-creative.js` | CREATIVE_FALLBACK + momentIds/techniqueIds |
| Audio mix | `src/render/audio-mix.js` | `duckingWindowCount` / `duckingSource` |
| EDL | `src/render/enrich-render-edl.js` | per-segment `audioSource` |
| Brief | `src/lib/brief-metrics.js` | soft warn at 40k segment / 60k drill |
| Docs | `docs/PIPELINE.md` | artifact + inspect snippet |
| Audit | `.cursor/work/montage-readiness-audit.md` | verdict + force sequence |

## Decisions

- 2026-07-23: Fidelity is sibling artifact `13b-montage-fidelity.json` (merge by `outputId` on partial re-renders).
- 2026-07-23: CLI warns on `|durationDriftSec| > 1` or any `CREATIVE_FALLBACK`; never hard-fails production by default.
- 2026-07-23: Brief soft guard uses segment budget 40k + drill-down 60k (existing 80k/200k kept as upper bands).
- 2026-07-23: Whole creative ffmpeg failure → `applied: []` and fallback rows with moment/technique ids.

## Progress

- [x] Readiness audit → `.cursor/work/montage-readiness-audit.md`
- [x] Polish discourse stopwords + tests (`ale` cannot become topic label)
- [x] Montage fidelity artifact + hooks + tests
- [x] Brief metrics soft guard (segment 40k / drill 60k + console.warn)
- [x] Docs (`PIPELINE.md` + this handoff + audit progress)
- [x] Related test suites green (102 tests)
- [x] Reviewer APPROVED — user can force re-run
- [ ] Ops force re-run of `51cd206d`

## Force re-run sequence (`51cd206d`)

```bash
# 1) Clean abstract (integrity auto-rebuilds; --force also wipes summarizer L1/L2 llm-cache)
node src/cli.js run --batch-id 51cd206d --from-step abstract --to-step abstract --force

# 2) Topics → direct → review (NO --reuse-llm-cache)
node src/cli.js run --batch-id 51cd206d --from-step topic_index --to-step review

# 3) Enhance + render
node src/cli.js run --batch-id 51cd206d --from-step audio_enhancement --to-step audio_enhancement
node src/cli.js render --batch-id 51cd206d --force --render-profile production
```

**Sanity after abstract:**

```bash
node -e 'const a=require("./output/.work/51cd206d/06-abstract.json"); console.log(new Set(a.L1.map(x=>x.sceneId)).size, a.L2.map(s=>s.summary.slice(0,80)))'
# expect unique L1 ≈ scene count; L2 seg002 must NOT start with "Brak dostarczonych"
```

**Inspect fidelity after render:**

```bash
# Summary per output
jq '.outputs[] | {outputId, recipeDurationSec, edlDurationSec, probedDurationSec, durationDriftSec, creative, audioMix}' \
  output/.work/51cd206d/13b-montage-fidelity.json

# Per-segment audio source / enhancement
jq '.outputs[].segments[] | {segmentId, clipIds, audioSource, preserveAmbientAudio, enhancementDecision}' \
  output/.work/51cd206d/13b-montage-fidelity.json

# Any creative fallbacks
jq '[.outputs[].creative.fallbacks[]]' output/.work/51cd206d/13b-montage-fidelity.json
```

CLI also prints soft fidelity warnings after render when drift > 1s or CREATIVE_FALLBACK is present.

## Next steps

1. Ops: run force sequence above (no `--reuse-llm-cache` for director/review).
2. Spot-check ambient + speech duck + enhancement vs fidelity entries.
3. Parent Reviewer pass on this Creator output.

## Blockers / open questions

- None for code; ops re-run still required for quality verdict on `51cd206d`.

## Verification

```bash
node --test \
  src/pipeline/steps/topic-index.test.js \
  src/render/montage-fidelity.test.js \
  src/lib/brief-metrics.test.js \
  src/render/audio-mix.test.js \
  src/render/ffmpeg-creative.test.js \
  src/render/enrich-render-edl.test.js \
  src/render/execute-render.test.js \
  src/render/build-render-edl.test.js
# → 102 pass
```
