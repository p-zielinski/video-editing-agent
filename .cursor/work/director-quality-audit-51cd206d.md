# Director quality audit — batch 51cd206d

> Last updated: 2026-07-23
> Branch: (local)
> Status: done (audit only — no code changes)

## Problem & goal

Does the director stack (super → segment → drill-down) actually understand the footage for batch `51cd206d` (~40 clips), or do payload format/size and upstream abstraction failures produce weak context → mediocre montage?

**Done looks like:** a documented verdict with evidence from real artifacts + code paths, ranked bottlenecks, and ranked recommendations — without implementing fixes in this step.

## Scope

- **In scope:** Prompt/brief construction; truncation/compaction caps; artifact richness (L1–L3, topics, audio, vision, words); cached director responses + provenance briefMetrics; final recipe quality signals; known failure-mode attribution.
- **Out of scope:** Code changes, re-runs, prompt rewrites, cache invalidation.

## Key files & context

| Area | Path | Role |
|------|------|------|
| Caps | `src/editorial/brief-caps.js` | L1/vision/words/audio/topic limits |
| Brief builder | `src/agents/director.js` | `buildDirectorBrief`, compact sceneMap, drill-down |
| Segment director | `src/agents/segment-director.js` | Scoped brief; `includeL1: false` |
| Super director | `src/agents/super-director.js` | L3 + segment catalog only |
| L1/L2/L3 | `src/agents/summarizer.js` | Abstraction; L1 cacheKey historically null |
| Chunking | `src/lib/abstraction-chunking.js` | L2 chunks; drill-down scene details |
| Metrics | `src/lib/brief-metrics.js` | Payload size warnings (80k / 200k) |
| Provenance | `output/.work/51cd206d/14-recipe-provenance.json` | Measured brief sizes |
| Usage | `output/.work/51cd206d/16-gpt-usage.json` | Real prompt token counts |
| Abstract | `output/.work/51cd206d/06-abstract.json` | Corrupted L1; empty L2 seg002 |
| Recipe | `output/.work/51cd206d/09-edit-recipe-final.json` | Final montage |
| Prior notes | `.cursor/work/montage-quality-51cd206d.md` | L1/L2 cache / topic_index hotfixes |

## Decisions

- 2026-07-23: **Overall verdict = systematically underfed *and* partially overloaded** (dual failure). Semantic layers (L1/L2/topics) are broken; raw transcript/audio/technique payloads are huge. Director leans on L3 + transcripts + vision scraps, then enrichers/sanitizers fill creative gaps.
- 2026-07-23: Scene-map compaction did **not** fire on this batch (42 scenes << dynamic threshold ~460 for 41 clips). Overload is not from compact omission — it is from full segment briefs + drill-down re-sending draft + catalogs.
- 2026-07-23: LLM caches store **responses only** (no request prompts). Payload evidence comes from `briefMetrics` + `16-gpt-usage.json` promptTokens.

## Progress

- [x] Read director / segment / super / brief-caps / summarizer / chunking
- [x] Compare abstract L1–L3 vs topic/audio/vision/words
- [x] Inspect director llm-cache responses + provenance briefMetrics + gpt usage
- [x] Inspect final recipe timeline / creativeMoments / audio decisions
- [x] Map known failure modes → root cause class
- [x] Write verdict + recommendations

## Findings

### 1) Prompt construction & token/size pressure

**How payloads are built**

| Stage | Input focus | Code |
|-------|-------------|------|
| Super | Segment catalog + `abstraction.L3` + userContext + aiHook | `super-director.js` ~73–89 |
| Segment | `buildDirectorBrief` on **scoped** timeline/words; injects full `L3` as `sessionSummary`; neighbor L2 one-liners; `includeL1: false` | `segment-director.js` ~91–181 |
| Drill-down | Full `draftRecipe` + `drillDownSceneDetails` (≤15 scenes) + transcripts/audio/topics + technique/retention catalogs | `director.js` ~1967–2147 |

**Caps / truncation** (`src/editorial/brief-caps.js`)

| Cap | Value |
|-----|-------|
| `L1_SUMMARY_MAX_CHARS` | 500 |
| `VISION_CAPTION_MAX_CHARS` | 200 |
| `OMITTED_SUMMARY_MAX_CHARS` | 120 |
| `maxWordsPerScene` | 120 |
| `L1_SCENE_SUMMARIES_THRESHOLD` | 30 |
| `BROLL_SYNC_HINTS_LIMIT` | 25 |
| Scene-map compact base | 30 / 50 + 10/clip (`director.js` ~796–815) |
| Compact triggers when | `sceneCount > threshold` |
| `DRILL_DOWN_SCENE_CAP` | 15 |
| Audio caps (director) | cut 12 / silence 8 / peaks 8 / events 10 / deadAir 10 / flat 8 |

**51cd206d measured sizes** (`14-recipe-provenance.json` + `16-gpt-usage.json`)

| Call | briefMetric est. tokens | Actual promptTokens |
|------|-------------------------|---------------------|
| super_director | ~2.0k | 3,738 |
| segment seg001 | ~82k | **136,325** |
| segment seg002 | ~91k | **148,167** |
| drill_down (11 scenes) | ~115k | **180,126** |
| **Director total** | ~290k est. user JSON | **~468k prompt** |

Warnings: single-call warn = 80k, total warn = 200k (`brief-metrics.js`). This batch blew past both.

**Approx composition (seg002 ~363 KB user JSON):** transcripts (~53 KB), summarized audio index (large share of 126 KB raw index), technique/retention catalogs, output schema, sceneMap×25 with vision captions, clipRegistry, constraints. Compact sceneMap **did not apply** (42 scenes vs ~460 threshold).

### 2) What director saw vs what was available

| Layer | Available in workdir | What director effectively got |
|-------|----------------------|-------------------------------|
| Vision | 40/40 `03-vision-*.json`; 174 captions in timeline; avg ~348 chars | Truncated to **200 chars** in sceneMap; good coverage (41/42 scenes) |
| Words | Rich (e.g. clip16 = 1156 words; seg2 clips all have speech) | Up to **120 words/scene** in excerpts — **this was the main usable signal** |
| Audio index | 126 KB; batch avg voice −37.9 LUFS; lots of silence | Summarized with DIRECTOR_AUDIO_CAPS into brief |
| Topics | 7 topics — all label **`"ale"`**, all match `clip25_scene001` | Noise / useless for B-roll sync |
| L1 | Should be 41 scene summaries | **Destroyed:** 41 identical entries, all `sceneId=clip01_scene001`, same dog-walk summary; `isNarrationSource=false` everywhere; unique L1 hit rate **1/42** |
| L2 seg001 | OK dog-walk summary | Present |
| L2 seg002 | Should cover clip17–40 | **"Brak dostarczonych opisów…"** — empty because L1 had no matching sceneIds |
| L3 | Coherent personal “przed 30.” arc (guesses around missing seg002) | Super + segment both see this; notes missing_context |

**Root of L1 corruption:** `llm-cache/abstract__summarizerL1.json` has `cacheKey: null` and a **single** scene response (`clip01`). Usage shows **one** L1 API call (`gpt-5.4-nano`, 3149 prompt tokens). Subsequent L1 calls reused that cache; responses kept `sceneId: clip01_scene001` even when summarizing other scenes (`summarizer.js` `summarizeScene` / batch fallback does not force `sceneInput.sceneId`). Cascades to empty L2 seg002 and garbage topics.

**Final recipe read (`09-edit-recipe-final.json`)**

- Main ~154s / short ~53s — sparse but thematically on-brand (cold open clip40 → dog rewind → clip16 VO → b-roll → clip28 face → clip29/40 closure).
- Intents/salvage text are **theme-aware** (L3-driven), not scene-detail-aware.
- Creative moments: mostly **enricher/sanitizer** (`enrich_payoff_*`, `sanitize_vlog_beat_*`); few director-authored (`cm_main_01`, short hook/beats).
- `audioEnhancementDecisions`: director originally **accepted** enh_clip16/17 (segment cache); final recipe shows **reject** with “accept bez udanego artefaktu…” while `07b-audio-enhancement-index.json` has **succeeded** dpdfnet artifacts — enricher/review fighting director.
- Duplicate mains appeared in drill-down response (`output_0_16x9` + `main_16x9`) before sanitize.

### 3) Known failure modes → cause class

| Failure | Primary cause | Class |
|---------|---------------|-------|
| Duplicate main (`output_0_16x9` + `main_16x9`) | Segment skeleton uses `main_16x9` but models invent `output_0_*`; drill-down merges both | **Schema/prompt ambiguity** (+ sanitize catch-up) |
| Invalid `narrativeIntent: "callback"` | LLM alias not in enum (fixer) | **Schema/validation** (coercion now exists) |
| Weak CTA from L3 summary | Closure enricher used long `sessionSummary` as CTA text | **Enricher fighting / bad default** (not missing director context) |
| Stacked `silence_beat` + quiet ending | Payoff enrich + music_drop + unenhanced quiet clip40 | **Enricher order / stacking** (+ weak audio end plan) |
| Reject enhancement despite succeeded artifact | Review/fixer rejected accepts without reconciling index | **Enricher/review vs director** (reconcile later added) |

**Not primarily “payload too big” for these five** — they are schema, enricher, and review-loop issues. Mediocre *editorial* choices (generic beats, weak B-roll matching) *are* driven by underfed L1/L2/topics plus overloaded catalogs drowning signal.

## Verdict (required)

### Overall: **systematically underfed** (semantic) **+ partially overloaded** (raw payload)

Director did **not** have a usable per-scene understanding of 40 clips. It had: (1) a decent L3 theme guess, (2) truncated vision captions, (3) heavy transcript excerpts, (4) audio summaries, and (5) a huge technique/schema tax. Montage is “plausible personal vlog” scaffolding, not data-dense cutting.

### Top 5 concrete bottlenecks

1. **L1 LLM cache collapse** — `output/.work/51cd206d/llm-cache/abstract__summarizerL1.json` (`cacheKey: null`, 1 scene) → `06-abstract.json` L1 all `clip01_scene001`. Code: `src/agents/summarizer.js` (~121–204) missing per-scene `cacheKey` + no `sceneId` rewrite from input.
2. **L2 seg002 empty** — `06-abstract-L2.json` / `06-abstract.json` L2[1]; super notes “brak pełnych opisów seg002” (`llm-cache/super_director__superDirector.json`). Cascades from (1).
3. **Topic index garbage** — `05b-topic-index.json` seven `"ale"` topics → useless `brollSyncHints` / ranking. Falls out of broken L1 topics + filler-heavy transcript keywords (`src/pipeline/steps/topic-index.js`).
4. **Segment/drill-down payload bloat** — `14-recipe-provenance.json` directorMetrics (~82k–115k est.; **136k–180k actual promptTokens** in `16-gpt-usage.json`). Drill-down re-embeds full draft + catalogs (`director.js` ~2083–2147) with only 11 scene details.
5. **Enricher/review overrides director audio & creative** — final rejects vs succeeded `07b-audio-enhancement-index.json`; creativeMoments dominated by `enrich_*` / `sanitize_*` in `09-edit-recipe-final.json`.

### Top 5 recommendations (impact order)

1. **Fix / gate abstraction integrity before direct** (highest) — refuse or auto-rebuild abstract when L1 unique `sceneId` count ≪ scene count; require per-scene L1 `cacheKey`; force `sceneId` from `sceneInput`. Without this, director cannot “understand” multi-clip days.
2. **Invalidate stale abstract LLM cache on `--force` or content-hash key** — current force skips artifact cache but reuses poisoned L1 (`montage-quality-51cd206d.md` already noted).
3. **Compaction for segment briefs (not sceneMap)** — strip/shrink technique catalog + outputSchema echo; summarize audio harder; keep transcripts but prefer L1+vision once L1 is fixed. Target &lt;40k prompt tokens/segment.
4. **Slim drill-down** — send patch instructions + scene details, not full draftRecipe + full catalogs again; keep `DRILL_DOWN_SCENE_CAP` but drop redundant schema.
5. **Schema / enricher order** — already partially done (duplicate-main sanitize, narrativeIntent coerce, enhancement reconcile, CTA sanitize). Next: make review respect succeeded enhancement index; stop stacking silence_beat on music_drop/quiet tails (payoff-enrich guards).

### What NOT to change yet

- Scene-map compact thresholds for this batch size (compaction never fired; not the bug).
- Raising `VISION_CAPTION_MAX_CHARS` / `maxWordsPerScene` further (adds tokens while L1 is broken).
- Model routing to a larger director model alone (will still read poisoned L1 + 180k-token drill-down).
- Rewriting creative technique packs / retention grammar until abstraction gates exist.
- Hand-editing `09-edit-recipe-final.json` as the “fix” — regenerate after clean abstract→direct.

## Next steps

1. Implement abstract integrity gate + L1 per-scene cacheKey / sceneId bind (recommendation 1–2).
2. Re-run `abstract` with LLM cache cleared for summarizerL1/L2 on `51cd206d`, then `direct`→`review`.
3. Re-measure `briefMetrics` / promptTokens; expect L2 seg002 to become real and topics to leave `"ale"`.
4. Only then tune segment/drill-down compaction (recommendations 3–4).

## Verification

Evidence gathered (read-only):

- Artifact sizes: L1 33 KB but 1 unique scene; L2 2 KB with empty seg002; audio index 126 KB; recipe ~102 KB.
- Provenance briefMetrics total ~289k est. tokens; usage promptTokens super 3.7k + seg 136k + 148k + drill 180k.
- Scene-map compact threshold ≈ 460; scenes 42 → no compact.
- L1 hit rate 1/42; vision coverage 41/42; seg2 transcripts present (24 excerpts in metrics).
- Director caches: response-only; enhancement accept in segment cache vs reject in final recipe vs succeeded index.

```bash
# Re-check after a clean abstract (future)
node -e 'const a=require("./output/.work/51cd206d/06-abstract.json"); console.log(new Set(a.L1.map(x=>x.sceneId)).size, a.L2.map(s=>s.summary.slice(0,80)))'
```
