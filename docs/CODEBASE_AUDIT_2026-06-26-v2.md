# Codebase Audit v2 — video-editing-agent

> Data: 2026-06-26  
> Testy: **160/160 pass** (24 suites)  
> Schema drift: **0** (10/10 Zod ↔ `schemas/json` in sync)  
> Zakres: re-audyt po drugiej rundzie fixów (topic_index, CLI, prompty, bbox, CI)

## Executive summary

**Ogólna dojrzałość: 7/10** (↑ z 6/10) — integracja spatial index + walidacja V21-09 + CI schema drift zamknęły większość luk z pierwszego audytu. Produkt nadal kończy się na JSON receptury; brak renderu i kilka driftów schema↔prompt blokują „production ready”.

| Obszar | v1 | v2 | Werdykt |
|--------|----|----|---------|
| Pipeline (12 kroków) | 7/10 | **7.5/10** | Spójny; resume `--from-step direct` pomija `spatial_index` |
| Summarizer L1 | 8/10 | **8/10** | Pola montażowe + Zod defaults; prompt v1 OK |
| Spatial index | 5/10 | **7/10** | Normalizacja bbox + stub bbox; 1 anchor/scena; brak walidacji `spatialRef` |
| Walidatory V21/V22 | 8/10 | **8.5/10** | V21-09 działa; V21-07 warning-only; brak cross-check bbox |
| Agenci (director/critic/fixer) | 6/10 | **7.5/10** | Drill-down + fixer wzbogacone; drift `spatialRef` schema vs prompt |
| Katalog technik + editorial | 8/10 | **8/10** | 27 technik, 3 packi, AJV w CI testach |
| Schema/export + CI | 7/10 | **8.5/10** | Drift check w GitHub Actions; brak Python/ffmpeg w CI |
| Testy | 7/10 | **7.5/10** | 160 unit (+5); brak e2e, orchestrator, fixer+spatial |
| Dokumentacja | 6/10 | **7.5/10** | Spec 12 kroków; `spatialRef` shape niespójny prompt↔schema |
| Gotowość produkcyjna | 3/10 | **3.5/10** | Brak renderu; repo niezacommitowane |
| Security/ops | 6/10 | **6.5/10** | API key gate dla `analyze`; `.env.example` OK |

---

## Weryfikacja claimed fixes

| Claim | Status | Dowód |
|-------|--------|-------|
| topic_index `l3Keywords` bug | ✅ **FIXED** | `topic-index.js:64-65` — `l3Keywords.includes(label)` zamiast `includes(count)`; test L3 keyword `topic-index.test.js:67-89` |
| CLI `spatial_index` + API key gate | ✅ **FIXED** | `cli.js:145` help; `cli.js:195-204` `needsApiKey` obejmuje `analyze` |
| Prompty V21-09 + spatialIndex director | ✅ **FIXED** | `prompts/v2/critic.md:10-25`, `fixer.md:19-21`, `director.md:41-50` |
| directorDrillDown + fixer payloads | ✅ **FIXED** | `director.js:471-473`; `fixer.js:72-80`; test `director.test.js:208-209` |
| Bbox normalization 0–1 + Florence stub | ✅ **FIXED** | `spatial-index.js:56-97`; stub `vision_florence.py:16`; testy `spatial-index.test.js` |
| EDITING_RECIPE_V2_SPEC 12 steps | ✅ **FIXED** | `EDITING_RECIPE_V2_SPEC.md:36`, `§11.4`, `05c`, `V21-09` tabela |
| CI export-schemas drift check | ✅ **FIXED** | `test.yml:23-30` |
| 160 tests passing | ✅ **CONFIRMED** | `npm test` — 160 pass, 0 fail |

---

## Delta vs audyt v1

| ID | Problem (v1) | v2 status |
|----|--------------|-----------|
| C1 | Brak renderu ffmpeg | 🔴 **Still open** |
| C2 | Spatial index pusty przy stub | 🟡 **Partial** — stub ma bbox 0–1 (`vision_florence.py:16`); `--no-objects` nadal = pusto |
| C3 | Bbox coords niezdefiniowane | ✅ **Fixed** — `normalizeBbox`, schema doc `spatial-index.js:7-8` |
| C4 | Brak face detector | 🔴 **Still open** — heurystyka labeli (`spatial-index.js:6-34`) |
| C5 | `analyze` bez API key | ✅ **Fixed** — `cli.js:198` |
| C6 | Repo bez commit | 🔴 **Still open** — `git status` all untracked |
| I1 | CLI `--from-step` bez `spatial_index` | ✅ **Fixed** — `cli.js:145` |
| I2 | Critic/fixer bez V21-09 | ✅ **Fixed** |
| I3 | Director bez spatialIndex guidance | ✅ **Fixed** |
| I4 | drillDown bez spatialIndex | ✅ **Fixed** |
| I5 | Fixer bez techniqueCatalog/spatial/wordIds | ✅ **Fixed** |
| I6 | topic_index bug | ✅ **Fixed** |
| I7 | Spec 11 vs 12 kroków | ✅ **Fixed** |
| I8 | CI bez schema check | ✅ **Fixed** |
| I9 | Retention auto przy `9:16` | 🟡 **Intentionally open** — `shorts-retention.js:73-74` |
| I10 | Vision stub default | 🟡 **Still open** — `cli.js:215`, `orchestrator.js:70` |
| N1 | Test director spatialIndex | ✅ **Fixed** — `director.test.js:50-63` |
| N2 | Walidacja spatialRef vs artifact | 🔴 **Still open** |
| N3 | export-schemas w CI | ✅ **Fixed** |
| N4 | Integration test spatial→validate | 🔴 **Still open** |
| **NEW** | `--from-step direct` pomija spatial_index | 🔴 **New** — `work-paths.js:75-77` |
| **NEW** | `spatialRef` schema ≠ director prompt | 🔴 **New drift** — schema `clipId/sceneId/timestampSec` vs prompt `sceneId/anchorType/bbox` |

Legenda: ✅ Fixed | 🟡 Partial / by design | 🔴 Open

---

## 1. Pipeline — 12 kroków

### Wiring

```5:18:src/pipeline/work-paths.js
export const PIPELINE_STEPS = [
  "ingest",
  "transcribe",
  "keyframes",
  "vision",
  "objects",
  "index",
  "clip_profile",
  "abstract",
  "topic_index",
  "spatial_index",
  "direct",
  "review",
];
```

Orchestrator (`orchestrator.js:102-231`) wykonuje kroki sekwencyjnie z idempotencją artefaktów (`shouldSkipArtifact`). Artefakt `05c-spatial-index.json` zapisuje `runSpatialIndexStep` (`orchestrator.js:215-218`).

### Resume / edge cases

| Scenariusz | Zachowanie | Ocena |
|------------|------------|-------|
| `npm run full` | Wszystkie 12 kroków | OK |
| `npm run direct` | `abstract` → `review` (w tym `topic_index`, `spatial_index`) | OK — `cli.js:9` |
| `run --from-step abstract` | Od abstract w górę | OK |
| **`run --from-step direct`** | **Pomija `spatial_index`** | **BUG** — `shouldRunStep` (`work-paths.js:75-77`): indeks spatial (9) < direct (10) |
| `analyze` | `ingest` → `index` tylko | By design; brak clip_profile/topic/spatial |
| Brak `05c` przy direct z cache draft | Director dostaje pusty spatial (`agents.js:40-45`) | Degradacja graceful |
| `RECIPE_VALIDATION_FAILED` | Exit 2, draft zachowany (`cli.js:225-229`) | OK |
| Review skip gdy valid final | `agents.js:130-137`, test `agents.test.js:56-67` | OK |
| Max 3 iteracje critic/fixer | `agents.js:12`, `151-186` | OK; brak testu pętli z fixer+spatial |

### Objects default

Live Florence domyślnie (`objectsStub=false`, `objects-enabled=true`) — `cli.js:216-217`, `objects-defaults.test.js:12-16`. Stub tylko z `--objects-stub`. Escape: `--no-objects` → brak detekcji → pusty spatial index.

---

## 2. Summarizer L1

**Completeness:** `summarizer.js:5-22` wymusza pola montażowe w `outputSchema`; `prompts/v1/summarizer.md:7-12` dokumentuje semantykę.

**Defaults / legacy:** `AbstractL1Schema` (`edit-recipe.js:119-128`) — `brollPotential` default 0.5, `topics` `[]`, `visualQuality` medium, `stability` unknown. Sceny bez treści dostają deterministyczne wartości (`summarizer.js:70-80`). Test legacy: `summarizer.test.js:29-46`.

**Edge cases:**

- Scena z samym vision bez transcript — OK (syntetyczne L1).
- Brak walidacji że `topics` z L1 są spójne z topic_index tokenizacją — akceptowalne (heurystyka downstream).
- L2/L3 bez testów edge (pusty batch, 1 scena) — luka testowa niska.

**Ocena: 8/10** — bez regresji; brak integration z live OpenAI.

---

## 3. Spatial index

### Normalizacja

`normalizeBbox` (`spatial-index.js:56-97`):
- Wejście 0–1 → pass-through (`isNormalizedBbox`).
- Piksele xywh gdy `x+w ≤ width` (`fitsPixelXywh`).
- Piksele x1y1x2y2 gdy xywh nie pasuje (`c > a && d > b`).
- Brak wymiarów → `null` → anchor odrzucony (`spatial-index.js:76-77`).

Wymiary z `scene.resolution` lub `timelineIndex.clips` (`spatial-index.js:99-109`).

### Stub path

`vision_florence.py:9-17` zwraca znormalizowany bbox `[0.25, 0.2, 0.5, 0.6]` dla `[stub] person` → `type: subject` po mapowaniu.

### Director consumption

`formatSpatialSummary` (`director.js:208-216`) — tylko sceny z anchorami; brief + drill-down (`director.js:312-314`, `471-473`).

### Ograniczenia (nadal istotne)

1. **Max 1 primary anchor** (+ opcjonalnie face) per scena (`spatial-index.js:136-169`) — multi-subject sceny tracą kontekst.
2. **Face = heurystyka stringów**, nie detector (`spatial-index.js:6-7`, `24-25`).
3. **Live Florence** — bbox z `post_process_generation`; normalizacja powinna działać, ale **brak testu integracyjnego** z realnym outputem.
4. **`spatialRef` w recepturze** — schema (`edit-recipe-v2.js:218-222`) to `{ clipId, sceneId, timestampSec }`, podczas gdy director prompt (`director.md:48`) każe `{ sceneId, anchorType, bbox }`. **LLM może generować pola odrzucone przez Zod lub ignorowane przez renderer.**
5. Brak walidacji że `spatialRef.bbox` (gdyby było) zgadza się z `05c-spatial-index.json`.

**Ocena: 7/10** (↑ z 5) — core fix solidny; kontrakt `spatialRef` niespójny.

---

## 4. Walidatory V1–V22

### V21 (`creative-moments.js`)

| Kod | Implementacja | Uwagi |
|-----|---------------|-------|
| V21-01 | `catalog.byId` | OK |
| V21-02 | `validateParams` | OK |
| V21-03 | level + `allowMidSentenceCuts` | OK |
| V21-04 | min gap per technique | OK |
| V21-05 | density / `maxPerOutputMinutes` | OK |
| V21-06 | `forbiddenOnSegmentRole` | OK |
| V21-07 | warning jeśli brak anchor | **Warning-only** — nie blokuje final (`creative-moments.js:292-312`) |
| V21-08 | empty reason | OK |
| V21-09 | word index + format regex | ✅ **Fixed** (`creative-moments.js:179-205`) |
| V21-STRUCT | segment bounds | OK |

**False positives:** V21-07 + wysokie `confidence` daje 2 warningi — OK. Brak false positive testów dla `spatialRef` shape mismatch.

### V22 (`shorts-retention.js`)

16 testów w `shorts-retention-validator.test.js`. Opt-in dla v2.0/v2.1 (`shouldRunShortsRetentionValidation`, `shorts-retention.js:107-110`). Auto-enable dla `9:16` w `shouldEnableShortsRetention` (`shorts-retention.js:73-74`) — **może wymuszać retention na director brief** gdy `requiredFormats` domyślnie `["16:9","9:16"]` (`cli.js:214`).

### Scene registry + recipe-v2

`validateBrollTopicIndex` (`recipe-v2.js:315-342`) — skip dla `broll_pool` clips. `BROLL_SCENE_NOT_IN_TOPIC_INDEX` tylko gdy `topicIndex.topics.length > 0`.

**Ocena: 8.5/10**

---

## 5. Agenci — pełna pętla

### Director

- Initial: `runDirector` + brief z spatial (`director.js:354-410`).
- Drill-down: wszystkie sceneIds z receptury (`agents.js:102-108`) — **może być kosztowne** dla długich timeline (brak limitu sceneIds).
- Payload drill-down: topicIndex, spatialIndex, techniqueCatalog, retention (`director.js:465-491`).

### Critic

- Heurystyki przez `validateRecipeV2` (`critic.js:82-95`).
- LLM payload: recipe, timelineCrossCheck, topicIndex, heuristicIssues, techniqueCatalogSummary (`critic.js:156-168`).
- **Brak `spatialIndex` w payload** — model nie widzi kotwic przy review narracyjnym spatial.

### Fixer

- `buildCreativeFixerContext`: techniqueCatalogSummary, spatialIndex summary, wordIdHint (`fixer.js:61-82`).
- Retention context gdy V22 aktywne (`fixer.js:85-110`).
- **Brak `topicIndex`** — trudniejsza naprawa `BROLL_SCENE_NOT_IN_TOPIC_INDEX`.
- Test fixer (`critic.test.js:60-78`) **nie przekazuje** spatialIndex/wordIndexes — nie weryfikuje enriched payload.

**Ocena: 7.5/10**

---

## 6. Techniques + editorial + retention

- Katalog: 27 JSON + 3 packi; AJV w `technique-catalog-schema.test.js`.
- `loadTechniqueCatalog`, `formatCatalogForPrompt`, `technique-budget` — dobrze przetestowane.
- Director `buildCreativityContext` (`director.js:118-205`) — pack resolution dla shorts energy vs retention.
- Retention grammar w prompt director (`director.md:96-120`) zsynchronizowany z walidatorem.

**Ryzyko produkcyjne:** domyślne `requiredFormats: 16:9,9:16` włącza retention w brief (`director.test.js:88-91`) — użytkownik bez shortów nadal dostaje V22 rules w constraints.

**Ocena: 8/10**

---

## 7. topic_index po fixie

Logika (`topic-index.js:44-111`):
1. Tokenizacja L3 → `l3Keywords`.
2. L2 keyword counts → kandydaci `count >= 2 || l3Keywords.includes(label)` ✅.
3. Dopasowanie słów w speech clips → `wordIds`, `timeRange`.
4. Fallback topic_001 z L3 slice (`topic-index.js:93-108`).
5. Scoring B-roll (`scoreSceneForTopic`, `topic-index.js:114-167`) — L1 fields, object detections, threshold.

**Pozostałe słabości:**
- `keywordOverlap` binarny 0/1 (`topic-index.js:19-27`) — brak partial match score.
- Topic labels to surowe tokeny L2, nie frazy.
- `objectDetections` bez bbox w timeline index nadal wspiera scoring label-only.

**Ocena: 7.5/10** — bug naprawiony; heurystyka nadal prosta.

---

## 8. CLI UX

| Flaga | Help | Implementacja |
|-------|------|---------------|
| `--from-step` | 12 kroków incl. `spatial_index` | ✅ `cli.js:145` |
| `--to-step` | OK | `cli.js:146` |
| API key | Wymaga dla analyze | ✅ `cli.js:195-204` |
| `--vision-live` | OK | `cli.js:153` |
| `--objects-stub` / `--no-objects` | OK | `cli.js:154-156` |
| Resume bez input | Wymaga `--from-step` | `cli.js:182-184` |
| Exit codes | 0/1/2 validation | `cli.js:225-229` |

**Luki:**
- Brak walidacji że `fromStep`/`toStep` ∈ `PIPELINE_STEPS` — typo → runtime error w `stepIndex`.
- `engines.node: <=22.x` (`package.json:28`) vs dev Node 24 — ostrzeżenie npm.
- `analyze` kończy na `index` — README jasne (`README.md:26`), ale użytkownik może oczekiwać clip_profile.

**Ocena: 7.5/10**

---

## 9. Schemas + export sync

- 10 schematów Zod → JSON (`export-json-schema.js:23-34`).
- **Drift check:** porównanie programowe — **NO DRIFT** (lokalnie).
- CI: `npm run export-schemas` + `git diff schemas/json` (`test.yml:23-30`).

**Niespójności semantyczne (nie drift plików):**
- `SpatialRefSchema` vs director prompt (patrz §3).
- `SpatialIndexSchema.bbox` = normalized xywh; `SpatialRefSchema` nie ma bbox.

**Ocena: 8.5/10** dla mechaniki export; **6/10** dla spójności kontraktów spatial.

---

## 10. Test coverage matrix

### Pokryte (23 pliki, 160 testów)

| Moduł | Plik testowy |
|-------|--------------|
| Agents | `director.test.js`, `critic.test.js`, `summarizer.test.js` |
| Pipeline steps | `topic-index`, `spatial-index`, `clip-profile`, `keyframes`, `agents`, `objects-defaults` |
| Validators | `creative-moments`, `recipe-v2-validator`, `scene-registry`, `shorts-retention-validator` |
| Editorial | `technique-budget`, `load-technique-catalog`, `format-catalog-for-prompt`, `shorts-retention`, `technique-catalog-schema` |
| Lib | `timeline-index`, `abstraction-chunking`, `build-output-timeline`, `migrate-recipe-v1-v2`, `srt-processor` |

### Niepokryte / słabo pokryte

| Obszar | Brak |
|--------|------|
| `orchestrator.js` | Brak testów integracyjnych kroków |
| `cli.js` | Brak testów parseArgs / needsApiKey |
| `runFixer` enriched payload | Test bez spatialIndex (`critic.test.js:74`) |
| `runCritic` + wordIndexes + V21-09 | Brak dedykowanego testu |
| `validateRecipeV2` + topicIndex B-roll | Brak testu w `recipe-v2-validator.test.js` |
| `spatialRef` validation | Brak |
| Resume `--from-step direct` | Brak |
| Python scripts | Brak CI |
| ffmpeg ingest/keyframes | Brak |
| E2E fixture batch | Brak |
| `transcribe.js` / `ingest.js` | Brak |

**Ocena: 7.5/10**

---

## 11. Dokumentacja

| Dokument | Stan |
|----------|------|
| `README.md` | Aktualny — 12 kroków, 05c, V21/V22, defaults wizji |
| `EDITING_RECIPE_V2_SPEC.md` v1.2 | 12 kroków, spatial_index §11.4, V21-09 |
| `~/.cursor/work/video-editing-agent.md` | Status done; zgodny z fixami |
| `CODEBASE_AUDIT_2026-06-26.md` | Superseded przez ten dokument |

**Drift docs↔code:** `spatialRef` shape w `director.md:48` ≠ `edit-recipe-v2.js:218-222`.

**Ocena: 7.5/10**

---

## 12. Production readiness

| Kryterium | Status |
|-----------|--------|
| End-to-end do receptury JSON | ✅ (z API keys + ffmpeg lokalnie) |
| Render wideo | ❌ `buildOutputTimeline` tylko czasy (`build-output-timeline.js`) |
| Muzyka / audio techniki | ❌ Katalog istnieje; brak executora |
| CI na GitHub | 🟡 `npm test` + schema drift; **wymaga pierwszego push** |
| Determinizm bez GPU | 🟡 Vision stub + objects live lub stub |
| Walidacja przed zapisem final | ✅ `agents.js:197-208` |
| Human review flag | ✅ `needsHumanReview` |
| Secrets | ✅ `.env.example`; nie commitować `.env` |

**Honest score: 3.5/10** — excellent analysis/director prototype; not a shipping video product.

---

## 13. Porównanie v1 → v2

### Co się poprawiło

1. **topic_index** — krytyczny bug L3 naprawiony + test.
2. **Spatial pipeline** — normalizacja bbox, stub z kotwicą, schema udokumentowana.
3. **Agent sync** — prompty V21-09, spatial w director/drill-down/fixer.
4. **CLI** — help kompletny, API key dla analyze.
5. **CI** — schema drift gate.
6. **Testy** — 155 → 160 (+spatial, +topic L3, +director spatial).

### Co nadal otwarte (priorytet)

**Krytyczne**
1. Brak renderu / ffmpeg z receptury.
2. Repo niezacommitowane — CI nie działa do pierwszego push.
3. `spatialRef` schema ↔ prompt drift — ryzyko invalid/empty creative moments.
4. `--from-step direct` pomija `spatial_index`.

**Ważne**
5. Brak walidacji `spatialRef` vs `05c-spatial-index.json`.
6. Critic bez spatialIndex w LLM payload.
7. Fixer bez topicIndex.
8. Retention auto przy domyślnym `9:16`.
9. CI bez Python/ffmpeg smoke test.
10. Vision stub default — słabsze L1 w dry-run.

**Nice-to-have**
11. Integration test: fixture batch → spatial_index → validateRecipeV2.
12. Test fixer z spatialIndex + wordIndexes.
13. CLI walidacja nazw kroków.
14. Multi-anchor per scene.
15. Dedicated face detector.

---

## Roadmap (uporządkowany)

1. **Commit + push** baseline — odblokuj CI.
2. **`spatialRef` contract** — ujednolić Zod, prompt, spec (bbox 0–1 vs timestampSec).
3. **Resume fix** — przy `--from-step direct` wymusić `spatial_index` jeśli brak `05c`.
4. **Walidator spatialRef** — cross-check sceneId + bbox z spatial index (V21-10?).
5. **Critic/fixer payload** — dodać spatialIndex (+ topicIndex do fixer).
6. **Real batch** z live Florence — zmierzyć % scen z anchorami.
7. **Render MVP** — segmenty + creativeMoments → ffmpeg filtergraph (minimal).
8. **CI** — Python import smoke, opcjonalnie ffmpeg `-version`.
9. **Retention gating** — rozważyć opt-in zamiast auto `9:16` (product decision).
10. **E2E test** — mocked OpenAI, fixture work dir przez 12 kroków.

---

## Indeks plików (kluczowe referencje)

| Temat | Ścieżka | Linie |
|-------|---------|-------|
| Pipeline steps | `src/pipeline/work-paths.js` | 5-18, 75-82 |
| Orchestrator | `src/pipeline/orchestrator.js` | 215-218 |
| topic_index fix | `src/pipeline/steps/topic-index.js` | 64-65 |
| Bbox normalize | `src/pipeline/steps/spatial-index.js` | 56-97 |
| Florence stub | `python/vision_florence.py` | 9-17 |
| CLI API key | `src/cli.js` | 195-204 |
| Director spatial | `src/agents/director.js` | 208-216, 312-314, 471-473 |
| Fixer context | `src/agents/fixer.js` | 61-82 |
| V21-09 | `src/validators/creative-moments.js` | 179-205 |
| SpatialRef schema | `src/schemas/edit-recipe-v2.js` | 218-222 |
| CI drift | `.github/workflows/test.yml` | 23-30 |
| Spec 12 steps | `docs/EDITING_RECIPE_V2_SPEC.md` | 36, 1164-1166 |

---

## Resolved in v3 (2026-06-26)

| ID | Problem | Fix |
|----|---------|-----|
| spatialRef schema ↔ prompt drift | ✅ `SpatialRefSchema` extended: `clipId`, `sceneId`, optional `timestampSec`, `anchorType`, `bbox` |
| N2 / V21-10 | ✅ Walidacja `spatialRef` vs `05c-spatial-index.json` |
| `--from-step direct` pomija spatial_index | ✅ `ensureSpatialIndex()` w `runDirectStep`, orchestrator, `runReviewStep` |
| Critic bez spatialIndex | ✅ Payload `spatialIndex` dla v2.1+ z creativeMoments |
| Fixer bez topicIndex | ✅ Kompaktowy `topicIndex` summary w payload |
| CLI typo fromStep/toStep | ✅ `validatePipelineStep()` w `work-paths.js` + CLI gate |
| I9 retention auto przy domyślnym 9:16 | ✅ `isShortOnlyFormatRequired` — dual format nie włącza retention |

**Testy:** 171 pass (+11). Schema drift: 0 po `npm run export-schemas`.

---

*Audyt read-only v2. Poprawki v3 zaimplementowane w tej sesji agenta.*
