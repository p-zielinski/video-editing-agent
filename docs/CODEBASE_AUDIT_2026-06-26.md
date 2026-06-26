# Codebase Audit — video-editing-agent

> Data: 2026-06-26  
> Testy: **155/155 pass** (24 suites)  
> Zakres: pełny audyt po poprawkach jakości (L1, spatial index, V21-09, CI)

## Executive summary

**Ogólna dojrzałość: 6/10** — silny pipeline analizy → receptura; brak renderu i kilka luk integracyjnych blokują produkcję.

| Obszar | Ocena | Werdykt |
|--------|-------|---------|
| Pipeline (12 kroków) | 7/10 | Spójny wiring; drobny drift CLI/spec |
| Summarizer L1 | 8/10 | Pola montażowe end-to-end |
| Spatial index | 5/10 | Heurystyki OK; bbox/stub/face to luki |
| Walidatory V21/V22 | 8/10 | Bogate; prompty nie w 100% zsynchronizowane |
| Agenci | 6/10 | Brief initial OK; drill-down/fixer cienkie |
| Katalog technik | 8/10 | 27 technik, 3 packi, schema CI |
| Schema/export | 7/10 | Zod + JSON; brak drift check w CI |
| Testy | 7/10 | 155 unit; brak e2e/integration batch |
| Dokumentacja | 6/10 | README OK; spec 11 vs 12 kroków |
| Gotowość produkcyjna | 3/10 | Brak render, muzyki, real e2e |
| Security/ops | 6/10 | .env, CI podstawowe |

---

## Co zostało poprawione (ta sesja)

| Zmiana | Status |
|--------|--------|
| L1: `brollPotential`, `topics`, `visualQuality`, `stability` | ✅ |
| Krok `spatial_index` → `05c-spatial-index.json` | ✅ |
| V21-09 walidacja `anchorWordId` | ✅ |
| README, handoff, export schemas | ✅ |
| GitHub Actions `test.yml` | ✅ |

---

## Mocne strony

1. **12-krokowy pipeline** — `work-paths.js` → orchestrator → README spójne; `spatial_index` przed `direct`.
2. **L1 → topic-index → director** — scoring B-roll używa pól z abstractu zamiast samych heurystyk.
3. **Warstwy receptury** — v2.0 (multi-clip) → v2.1 (techniki) → v2.2 (retencja shortów) z walidatorami.
4. **155 testów** — validators, editorial, pipeline steps, mocked agents.
5. **Technique registry** — rozszerzalny katalog JSON + packi + AJV w CI.

---

## Krytyczne (przed produkcją)

### 1. Brak renderu
Wynik to `09-edit-recipe-final.json`. `buildOutputTimeline` istnieje, ale nic nie mapuje na ffmpeg. Bez tego produkt kończy się na planie montażu.

### 2. Spatial index pusty w typowym dev run
- Florence stub (`vision_florence.py`) nie zwraca `bbox`
- `spatial-index.js` filtruje tylko wpisy z `bbox.length === 4`
- **Efekt:** dry-run bez live Florence = brak anchorów → zoomy bez `spatialRef`

### 3. Układ współrzędnych bbox niezdefiniowany
Testy używają 0–1 znormalizowanych; Florence zwraca piksele. Brak normalizacji w pipeline — przyszły renderer może źle kadrować.

### 4. Brak prawdziwej detekcji twarzy
`FACE_LABELS` to heurystyka na stringach labeli Florence OD (`person`), nie dedykowany face detector.

### 5. `analyze` bez wczesnej walidacji API key
CLI nie wymaga `OPENAI_API_KEY` dla `analyze`, ale `transcribe` failuje w środku pipeline.

### 6. Repozytorium bez commit baseline
Cała praca może być niezacommitowana — CI na GitHub wymaga push.

---

## Ważne do poprawy

| # | Problem | Lokalizacja |
|---|---------|-------------|
| 1 | CLI `--from-step` bez `spatial_index` | `src/cli.js:145` |
| 2 | Critic/fixer prompty bez V21-09 | `prompts/v2/critic.md`, `fixer.md` |
| 3 | Director prompt bez instrukcji `spatialIndex` → `spatialRef` | `prompts/v2/director.md` |
| 4 | `directorDrillDown` bez `spatialIndex` | `src/agents/director.js` |
| 5 | Fixer bez `techniqueCatalog`, `spatialIndex`, `wordIds` | `src/agents/fixer.js` |
| 6 | **Bug topic_index:** `l3Keywords.includes(count)` — porównuje stringi z liczbą | `topic-index.js:65` |
| 7 | Spec mówi 11 kroków, brak `05c`, brak V21-09 | `docs/EDITING_RECIPE_V2_SPEC.md` |
| 8 | CI tylko `npm test` — brak schema export check, Python, ffmpeg | `.github/workflows/test.yml` |
| 9 | Retencja auto przy `9:16` w requiredFormats — może być niechciane | `shorts-retention.js` |
| 10 | Vision domyślnie stub — słabsze L1 bez `--vision-live` | `orchestrator.js` |

---

## Nice-to-have

- Test directora: `spatialIndex` w brief
- Walidacja `spatialRef` vs spatial index artifact
- `npm run export-schemas` w CI
- Integration test: fixture batch przez `spatial_index` → `validateRecipeV2`
- Overlay budget — już V22-07, ewentualnie dopracowanie

---

## Roadmap (kolejność)

1. **Commit + tag** baseline
2. **Szybkie fixy:** topic_index bug, CLI help, prompty V21-09/spatialIndex, drill-down/fixer payload
3. **Normalizacja bbox** 0–1 + kontrakt w `SpatialIndex` schema
4. **Real batch run** z live Florence — zmierzyć pokrycie anchorów
5. **Aktualizacja spec** — 12 kroków, spatial index, V21-09
6. **Render MVP** — segmenty → ffmpeg concat
7. **Muzyka/LUFS** — audio techniki z katalogu

---

## Indeks plików

| Temat | Ścieżki |
|-------|---------|
| Pipeline | `src/pipeline/work-paths.js`, `orchestrator.js`, `steps/` |
| L1 | `src/agents/summarizer.js`, `prompts/v1/summarizer.md` |
| Spatial | `src/pipeline/steps/spatial-index.js`, `src/schemas/spatial-index.js` |
| Walidatory | `src/validators/creative-moments.js`, `shorts-retention.js`, `recipe-v2.js` |
| Agenci | `src/agents/director.js`, `critic.js`, `fixer.js` |
| Techniki | `techniques/`, `src/editorial/` |
| Testy | `tests/`, `src/**/*.test.js` |
| CI | `.github/workflows/test.yml` |
