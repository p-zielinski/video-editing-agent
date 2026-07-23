# Montage readiness audit — stack + scale + pre–force-run

> Last updated: 2026-07-23  
> Branch: (local)  
> Status: done (audit) + code must-fixes landed in `.cursor/work/montage-readiness-fidelity.md`  
> Batch: `51cd206d` (~40 clips); scale lens: 2–3h / 80–150 clips

## Problem & goal

Is the current director→enrich→review→render stack a *realistically good* montage recipe now? Will it hold at larger scale? What must be fixed before `--force` on `51cd206d`?

**Done:** Verdict, scale assessment, ranked must-fix (≤7), fidelity-log sketch, explicit “do not change” list.

## Scope

- **In scope:** End-to-end health given recent fixes; scale risks; remaining bugs/gaps; recipe↔render mismatch logging design.
- **Out of scope:** Code implementation, live re-run, prompt rewrites.

## Key files & context

| Area | Path | Role |
|------|------|------|
| L1 integrity | `src/agents/summarizer.js`, `src/pipeline/steps/agents.js` (`runAbstractStep`) | cacheKey / sceneId bind / integrity gate / force wipe |
| Brief slim | `src/editorial/brief-caps.js`, `src/agents/director.js`, `src/agents/brief-slim.test.js` | ~18k est. tokens/segment (fixture) |
| Ambient | `src/editorial/intentional-ambient.js`, EDL/mix gates | preserveAmbientAudio |
| Speech duck | `src/editorial/speech-ducking.js`, `src/render/audio-mix.js` | deterministic duckingWindows |
| Enhancement | `src/pipeline/steps/audio-enhancement.js`, `src/render/resolve-render-context.js` | reconcile + accept-only enhanced paths |
| Sanitizers | `src/editorial/recipe-hard-error-sanitize.js` | duplicate main, stacked ducks, CTA, adjacent dups |
| Render | `src/render/build-render-edl.js`, `execute-render.js`, `ffmpeg-creative.js` | EDL → MP4; CREATIVE_FALLBACK |
| Topics | `src/pipeline/steps/topic-index.js` | B-roll sync; still weak stopwords |
| Prior audits | `.cursor/work/director-quality-audit-51cd206d.md`, `brief-slim.md`, `intentional-ambient-audit.md`, `speech-aware-mix.md` | evidence base |

## Decisions

- 2026-07-23: **Verdict = ready-with-caveats** for ~40-clip vlog batches after a clean abstract→topic→direct→review→render (no stale director LLM reuse).
- 2026-07-23: Scale to 2–3h / 80–150 clips is **architecturally plausible but unproven**; cost and drill-down coverage are the ceilings, not a single showstopper bug.
- 2026-07-23: On-disk `51cd206d` abstract is **still poisoned** (1 unique L1 sceneId; empty L2 seg002; topics all `"ale"`). Code gates exist; **ops re-run has not landed**.

---

## Verdict

### **ready-with-caveats**

The stack is now a *realistic* montage recipe for day-in-the-life multi-clip batches **if** semantic layers (L1/L2/topics) are healthy and director LLM caches are not reused from the poisoned era. Hard render failures that previously blocked production (crop 4K, concat duration drift, zoompan `CREATIVE_FALLBACK`, duplicate mains, review schema crashes, enhancement reject-vs-artifact) are largely fixed in code with tests.

It is **not** “ready” in the sense that pressing `--force` on today’s workdir alone will produce a good montage — the cached abstract/topics are still garbage until abstract (+ dependent topic_index) rebuilds.

---

## End-to-end health (director → enrich → review → render)

| Stage | Health | Notes |
|-------|--------|-------|
| **Abstract** | Code: **good**; batch disk: **bad** | Integrity gate + per-scene `cacheKey` + `bindL1SceneId` + force wipe implemented. Live `06-abstract.json`: 41 L1 rows, **1** unique sceneId / summary; L2 seg002 = empty filler. |
| **Topic index** | Fragile | Depends on abstraction (artifact-deps). Current `05b-topic-index.json` = seven `"ale"` topics. STOP_WORDS omit Polish discourse fillers (`ale`, `no`, `więc`, …). Empty-embed 400 fixed. |
| **Super / segment / drill-down** | Code: **good** (slim) | Fixture: ~18k est. tokens/segment (budget 40k). Drill-down drops full `draftRecipe` + schema (~72% bytes). Live tokens not re-measured post-slim. |
| **Enrichers** | Mixed | Speech duck, ambient preserve, payoff/CTA/dead-air guards, speech auto-accept (add-only) — solid. Creative timeline still often **enricher/sanitizer-authored** when director underfed. |
| **Review** | Code: **good** | Hard-error sanitize, consistency auditor (`08b`), recipe-fingerprint critic cache, max 3 iterations. Stale `--reuse-llm-cache` still a footgun if fingerprints miss edge cases. |
| **Audio enhancement** | Code: **good** | Decision-gated enhanced WAVs; preserveAmbient skips denoise; reconcile won’t flip intentional ambient rejects. |
| **Render** | Code: **good** | Hard concat, iw/ih crop, zoompan→scale/crop punch, EDL `preserveAmbientAudio`. Manifest records warnings / mix flags but **no structured recipe↔render fidelity**. Silent `CREATIVE_FALLBACK` still copies input on ffmpeg creative failure. |

**Net:** Pipeline *can* produce a coherent, on-brand montage once abstract is clean. Current `09` + renders reflect the **poisoned** semantic stack + later sanitizer patches — not the post-fix quality bar.

---

## Scale assessment (2–3h source, 80–150 clips)

Assume ~1 scene/clip → **80–150 L1**, L2 ≈ `sourceHours / ~10min` → **12–18 segments**, segment directors ≈ same count.

| Risk | Severity | Why |
|------|----------|-----|
| **L1 cost/latency** | **High** | Speech scenes = **1 LLM call each** (silent batch ≤8). 150 spoken scenes ≈ 150 nano calls + sequential loop in `buildAbstractionBundle`. Integrity gate prevents poison but not cost. |
| **Segment director fan-out** | **Medium–High** | One call per L2 segment; concurrency default **3**. At ~18–40k tokens/call post-slim: manageable tokens, wall-clock grows linearly. |
| **Drill-down coverage** | **High (quality)** | `DRILL_DOWN_SCENE_CAP = 15` — fine for ~40-clip sparse recipes; **under-covers** 80–150-clip timelines. Metadata salvage exists; deep refine does not scale. |
| **Scene-map compact** | **Medium** | Threshold ≈ `50 + 10×clipCount` (×1.25 if scenes>80). At 150 clips ≈ **1550** — compact **never fires** for multi-clip days. Brief slim is the real defense, not compact. |
| **Topic / embeddings** | **Medium** | Embeds scale with topics × B-roll scenes; chunking at 50. Garbage labels waste B-roll sync regardless of scale. |
| **Review loops** | **Medium** | ≤3 iterations × critic/fixer/super; larger recipes → larger fix payloads + more validation surface. Fingerprint helps cache safety. |
| **Render / DPDFNet** | **Medium** | Time ≈ output duration × passes + **per-accept** enhancement. 2–3h *source* does not imply 2–3h *output*; 80–150 accepts would dominate wall-clock. |
| **Token budgets after slim** | **Low–Medium** | Segment budget 40k est. looks OK for ~20–40 scenes/segment. Very dense speech + vision in one L2 segment could still approach warn bands — re-measure on first large live batch. |

**Scale verdict:** Holds as a **costly but coherent** design up to ~2–3h / ~100 clips if L1 is healthy and users accept longer abstract+direct wall-clock. Above that, need L1 batching for speech, higher segment concurrency, and multi-pass or hierarchical drill-down — **not** required for `51cd206d` force re-run.

---

## Remaining bugs / gaps (ranked)

### Must-fix before `--force` re-run of `51cd206d` (max 7)

| # | Item | Why | Paths |
|---|------|-----|-------|
| **1** | **Rebuild abstract (ops)** — disk L1 still collapsed | Without this, director cannot understand footage; everything downstream is themed scaffolding | `output/.work/51cd206d/06-abstract.json`; gate: `src/agents/summarizer.js` (`assertAbstractL1Integrity`), `src/pipeline/steps/agents.js` (`runAbstractStep`) |
| **2** | **Do not `--reuse-llm-cache` for director/review after abstract** | Old segment/drill/critic caches encode poisoned L1/L2/topics; reuse reproduces mediocre montage | `llm-cache/*director*`, `*critic*`, `*fixer*`; CLI cache semantics in `director-quality-and-ambient.md` |
| **3** | **Ensure topic_index rebuilds after new abstract** | Artifact-deps list abstract as parent; confirm step runs (or `--force` topic). Current topics = `"ale"` | `src/pipeline/steps/topic-index.js`, `src/pipeline/artifact-deps.js` |
| **4** | **Polish discourse stopwords in topic extractor** | Even with good L2 keywords, transcript filler `"ale"` floods topics (length>2 bypasses short stopwords) | `src/pipeline/steps/topic-index.js` (`STOP_WORDS`) |
| **5** | **Montage fidelity log artifact** (minimal) | Catch CREATIVE_FALLBACK, duration drift, enhanced-audio ignore, silence_beat soft-disable without eyeballing MP4s | See design below; hooks in `execute-render.js` / `ffmpeg-creative.js` / `audio-mix.js` / `build-render-edl.js` |
| **6** | **Re-measure live briefMetrics / promptTokens post-slim** | Fixture ≠ production; abort/alert if segment ≫40k est. or drill ≫~60k | `src/lib/brief-metrics.js`, `14-recipe-provenance.json`, `16-gpt-usage.json` |
| **7** | **Clear/invalidate poisoned summarizerL1\* before or via abstract** | Legacy `abstract__summarizerL1.json` still present (`cacheKey: null` era); integrity path clears on fail/force — verify wipe in logs | `src/pipeline/steps/agents.js` (`clearSummarizerAbstractLlmCache`) |

Items **1–3 + 7** are primarily **runbook**; **4–6** are small code/observability. Without **1–3**, force re-run wastes money.

### Nice-to-have (not blocking this force re-run)

- Director prompt rule for ambient listen cues (enricher already covers).
- Lower multi_clip scene-map compact thresholds (brief slim already shipped).
- Raise / hierarchical drill-down beyond 15 scenes (scale only).
- L1 speech batching / parallel summarize (scale cost).
- Enricher budget so director-authored moments aren’t drowned by `enrich_*` / `sanitize_*`.
- Rotation-aware ingest `probeVideoDimensions` (crop already iw/ih-safe).
- Optional A/B re-render of ambient outdoor listen segment.

---

## Known recipe↔render mismatches → what logging would catch

| Mismatch | Status in code | What to log |
|----------|----------------|-------------|
| **CREATIVE_FALLBACK** | Still: ffmpeg creative failure → copy input (`ffmpeg-creative.js`) | Per-moment: `techniqueId`, `momentId`, ffmpeg error, `applied: false` |
| **Duration drift** | Hard concat fixed; residual from beat snaps / speed / dropped segs | `edl.durationSec` vs `probeDuration(output)`; per-segment planned vs rendered |
| **Enhanced audio ignored** | Fixed via accept-only map + preserve gate | Per clipId: decision action, index status, path chosen (`enhanced` \| `original`), `preserveAmbientAudio` |
| **silence_beat** stacked / ambient | Soft-disable + payoff skip + stacked sanitize | Planned moments vs `disabled`; mix `appliedAudioTechniques` vs recipe set |
| **Duplicate / wrong output id** | Sanitize prefers `main_16x9` / `short_9x16` | Manifest still can show legacy `output_1_9x16` from older renders — log recipe `outputId` ↔ file path |
| **Stub/partial techniques** | V27-RENDER-01 validator | Support level + whether creative pass applied or skipped |
| **Speech duck missing** | Enricher + render fallback | Window count, source (`speech_derived` \| `director` \| `fallback`) |

Manifest today (`13-render-manifest.json`) has duration, warnings[], mix flags — **insufficient** for systematic fidelity diffs.

---

## Design sketch: montage fidelity log

**Artifact:** `13b-montage-fidelity.json` (or nested `fidelity` on `13-render-manifest.json`).

**Shape (conceptual):**

```json
{
  "version": "1.0",
  "batchId": "…",
  "recipePath": "09-edit-recipe-final.json",
  "outputs": [{
    "outputId": "main_16x9",
    "recipeDurationSec": 154.2,
    "edlDurationSec": 154.2,
    "probedDurationSec": 149.6,
    "durationDriftSec": -4.6,
    "segments": [{
      "segmentId": "…", "clipId": "…",
      "audioSource": "original|enhanced",
      "preserveAmbientAudio": false,
      "enhancementDecision": "accept|reject|none",
      "enhancementIndexStatus": "succeeded|missing|…"
    }],
    "creative": {
      "planned": ["hook_visual_punch", "silence_beat", "…"],
      "applied": ["…"],
      "fallbacks": [{ "code": "CREATIVE_FALLBACK", "momentId": "…", "message": "…" }],
      "disabled": [{ "momentId": "…", "techniqueId": "silence_beat", "reason": "intentional_ambient_preserve" }]
    },
    "audioMix": {
      "applied": true,
      "duckingWindowCount": 12,
      "duckingSource": "speech_derived",
      "appliedAudioTechniques": ["silence_beat"],
      "sfxWarnings": []
    }
  }]
}
```

**Hooks:**

| Hook | Record |
|------|--------|
| `buildRenderEdl` / `enrich-render-edl` | Per-segment audio source resolution, preserve flags, planned duration |
| `execute-render` (`renderOutput`) | Probe vs EDL; aggregate segment + pass warnings into fidelity blob; write artifact with manifest |
| `ffmpeg-creative` `applyCreativeMoments` | Every `CREATIVE_FALLBACK` with moment ids (today only generic message) |
| `audio-mix` `applyAudioMix` | `appliedAudioTechniques`, ducking window count/source, sfx warnings |
| Optional: `resolve-render-context.buildEnhancedAudioPaths` | Accept/reject map snapshot at render start |

**Gate:** warn in CLI when `|durationDriftSec| > 1.0` or any `CREATIVE_FALLBACK`; do not hard-fail production unless flagged.

---

## What NOT to change before re-run

- Scene-map compact thresholds / `SCENE_MAP_LARGE_BATCH_*` (not the failure mode for this batch).
- Raising `VISION_CAPTION_MAX_CHARS` / default `maxWordsPerScene` (adds tokens; L1-good path already drops to 40).
- Director model upgrade alone (won’t fix poisoned/stale semantics).
- Rewriting technique packs / retention grammar wholesale.
- Hand-editing `09-edit-recipe-final.json` as the “fix”.
- DPDFNet attn limits / sidechain architecture / default `GAP_DUCK_DB`.
- Broad prompt rewrites before measuring post-clean-abstract quality.

---

## Recommended force re-run sequence (`51cd206d`)

```bash
# 1) Clean abstract (integrity auto-rebuilds; --force also wipes summarizer L1/L2 llm-cache)
node src/cli.js run --batch-id 51cd206d --from-step abstract --to-step abstract --force

# 2) Topics → direct → review (NO --reuse-llm-cache)
node src/cli.js run --batch-id 51cd206d --from-step topic_index --to-step review

# 3) Enhance + render
node src/cli.js run --batch-id 51cd206d --from-step audio_enhancement --to-step audio_enhancement
node src/cli.js render --batch-id 51cd206d --force --render-profile production
```

**Sanity checks after abstract:**

```bash
node -e 'const a=require("./output/.work/51cd206d/06-abstract.json"); console.log(new Set(a.L1.map(x=>x.sceneId)).size, a.L2.map(s=>s.summary.slice(0,80)))'
# expect unique L1 ≈ scene count; L2 seg002 must NOT start with "Brak dostarczonych"
```

---

## Progress

- [x] Read prior audits + key code paths
- [x] Inspect live `51cd206d` abstract / topics / usage / manifest
- [x] Scale + must-fix + fidelity sketch
- [x] Write this audit
- [x] Code: Polish stopwords (#4)
- [x] Code: montage fidelity log (#5) → `13b-montage-fidelity.json`
- [x] Code: brief metrics soft guard (#6)

## Next steps

1. Ops: run abstract→review→render sequence above (no `--reuse-llm-cache`).
2. Inspect `13b-montage-fidelity.json` after render; spot-check ambient + speech duck + enhancement on final MP4s.
3. Re-measure live promptTokens / briefMetrics on clean abstract.

## Verification (this audit)

- Disk: L1 unique ids **1/41**; L2 seg002 empty; topics `"ale"`; usage totals ~1.67M prompt tokens (poisoned-era director/review).
- Code present: L1 integrity tests, brief-slim fixture ~18k/40k, ambient/speech/enhancement/render tests referenced in prior handoffs.
- No code changed in this step.
