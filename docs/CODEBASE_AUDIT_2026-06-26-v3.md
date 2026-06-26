# Codebase Audit v3 — video-editing-agent

> Data: 2026-06-26  
> Testy: **171/171 pass** (25 suites)  
> Schema drift: **0** (export-schemas verified)  
> Zakres: re-audyt po fixach v3 (spatialRef, V21-10, resume, agent payloads, retention gating)

## Executive summary

**Ogólna dojrzałość: 7.5/10** (v1: 6 → v2: 7 → **v3: 7.5**)

Warstwa analizy → receptura jest spójna end-to-end. Główne luki integracyjne z v2 zamknięte. Produkt nadal kończy się na JSON — brak renderu blokuje „shipping”.

| Obszar | v1 | v2 | v3 |
|--------|----|----|-----|
| Pipeline | 7 | 7.5 | **8** |
| Summarizer L1 | 8 | 8 | **8** |
| Spatial / spatialRef | 5 | 7 | **8** |
| Walidatory | 8 | 8.5 | **8.5** |
| Agenci | 6 | 7.5 | **8** |
| Techniques + editorial | 8 | 8 | **8** |
| Schema/CI | 7 | 8.5 | **8.5** |
| Testy | 7 | 7.5 | **8** |
| Dokumentacja | 6 | 7.5 | **7** |
| Gotowość produkcyjna | 3 | 3.5 | **3.5** |

---

## Weryfikacja fixów v3

| Claim | Status |
|-------|--------|
| `spatialRef` unified schema | ✅ `edit-recipe-v2.js:219-230` — refine wymaga `timestampSec` LUB `(bbox + anchorType)` |
| V21-10 vs spatial index | ✅ `creative-moments.js` — 6 testów |
| `ensureSpatialIndex` przy resume | ✅ `agents.js`, `orchestrator.js` |
| Critic `spatialIndex` payload | ✅ `critic.js` + test |
| Fixer `topicIndex` summary | 🟡 Partial — compact (topicId, label, count); bez sceneIds |
| CLI `validatePipelineStep` | ✅ `work-paths.js` + `cli.js` |
| Retention gating dual format | ✅ `isShortOnlyFormatRequired` — domyślne `16:9+9:16` nie włącza retention |
| 171 tests | ✅ Confirmed |

---

## Delta vs audyt v2

| Problem v2 | v3 |
|------------|-----|
| spatialRef schema ↔ prompt drift | ✅ **Fixed** |
| `--from-step direct` pomija spatial | ✅ **Fixed** (`ensureSpatialIndex`) |
| Brak V21-10 | ✅ **Fixed** |
| Critic bez spatialIndex | ✅ **Fixed** |
| Fixer bez topicIndex | 🟡 **Partial** |
| Retention auto przy domyślnym 9:16 | ✅ **Fixed** (tylko explicit short-only / context) |
| Brak renderu | 🔴 **Open** |
| Repo uncommitted | 🔴 **Open** |
| Face detector | 🔴 **Open** |
| E2E / orchestrator tests | 🔴 **Open** |

---

## Mocne strony (v3)

1. **Kontrakt spatialRef** — schema, prompty, spec zsynchronizowane; refine Zod chroni przed pustymi kotwicami.
2. **V21-01…V21-10 + V22** — kompletna warstwa walidacji montażowej z testami.
3. **12-krokowy pipeline** z graceful `ensureSpatialIndex` przy wznowieniu.
4. **171 testów** — validators, editorial, spatial, agents, retention, creativity.
5. **CI** — `npm test` + schema drift gate.

---

## Krytyczne (przed produkcją)

### 1. Brak renderu ffmpeg
Receptura kończy na `09-edit-recipe-final.json`. `buildOutputTimeline` liczy czasy — nie produkuje pliku wideo.

### 2. Repozytorium bez commit baseline
Cała praca może być niezacommitowana — GitHub Actions wymaga push.

### 3. Stale `05c-spatial-index.json`
Jeśli użytkownik `--force` na `objects` (nowe bbox), ale `direct` bez `--force` — może użyć starego spatial index. Brak invalidacji 05c przy zmianie 04-objects.

---

## Ważne

| # | Problem | Lokalizacja |
|---|---------|-------------|
| 1 | V21-10 bbox drift = **warning only** — final może przejść z złym bbox | `creative-moments.js` |
| 2 | V21-10 nie sprawdza `clipId` vs `sceneId` prefix | `creative-moments.js` |
| 3 | Fixer topicIndex bez `matchingScenes[].sceneId` — słaba naprawa B-roll | `fixer.js` |
| 4 | README może być nieaktualny względem retention gating | `README.md` |
| 5 | Brak testu `validateBrollTopicIndex` w recipe-v2-validator | tests |
| 6 | Vision stub default — słabsze L1 | `orchestrator.js` |
| 7 | CI bez Python/ffmpeg smoke | `.github/workflows/test.yml` |
| 8 | Critic LLM nie dostaje pełnego topicIndex | `critic.js` |

---

## Nice-to-have

- Orchestrator integration test (mocked steps)
- CLI args unit tests
- Multi-anchor per scene
- Dedicated face detector
- Invalidate 05c when 04-objects changes (manifest versioning)
- E2E fixture batch 12 kroków

---

## Production readiness: 3.5/10

| Kryterium | Status |
|-----------|--------|
| Analiza → receptura JSON | ✅ |
| Walidacja przed final | ✅ |
| Spatial anchors (stub/live) | ✅ |
| Render wideo | ❌ |
| Muzyka / audio techniki executor | ❌ |
| CI na remote | 🟡 wymaga push |
| Human review flag | ✅ |

---

## Roadmap (kolejność)

1. **Git commit + push** — baseline
2. **Artifact invalidation** — 05c stale przy force objects
3. **README sync** — retention gating, V21-10, spatialRef shape
4. **Fixer topicIndex** — pełniejszy matchingScenes w payload
5. **Real batch** z live Florence
6. **Render MVP** — ffmpeg z receptury
7. **E2E test** — mocked OpenAI, fixture przez 12 kroków

---

## Indeks plików

| Temat | Ścieżka |
|-------|---------|
| spatialRef schema | `src/schemas/edit-recipe-v2.js:219-230` |
| V21-10 | `src/validators/creative-moments.js` |
| ensureSpatialIndex | `src/pipeline/steps/agents.js` |
| Retention gating | `src/editorial/shorts-retention.js` |
| CLI validation | `src/pipeline/work-paths.js`, `src/cli.js` |
| Critic payload | `src/agents/critic.js` |
| Fixer payload | `src/agents/fixer.js` |
| Audyty | `docs/CODEBASE_AUDIT_2026-06-26*.md` |

*Audyt read-only v3. Poprawki v3 zaimplementowane w osobnej sesji subagenta.*

---

## v4 improvements (2026-06-26)

| Obszar | Zmiana |
|--------|--------|
| Pipeline | `artifact-deps.js` — invalidacja stale `05c` gdy nowszy timeline/objects; orchestrator + `ensureSpatialIndex` |
| Spatial | `clipId` na scenach spatial index; `builtFrom` metadata; `spatial-ref.js` helpery |
| V21-10 | `clipId` vs `sceneId`; bbox/anchorType error przy confidence > 0.6 |
| Agenci | Wspólny `topic-index-summary.js` — critic/fixer dostają `matchingScenes[].sceneId` |
| Director | `spatialRefExamples` w brief i drill-down |
| Testy | orchestrator, cli, artifact-deps, spatial-ref, validateBrollTopicIndex (+ ~20 nowych) |
| Docs | README: retention gating, spatialRef, stale rebuild |

**Nowy wynik testów:** ≥185 pass (po v4 session).
