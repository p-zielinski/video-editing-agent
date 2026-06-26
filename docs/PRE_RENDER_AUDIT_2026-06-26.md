# Pre-render Pipeline Audit — 2026-06-26

> Scope: **wszystko przed montażem ffmpeg** — analiza → pełny plan wideo → EditRecipe JSON  
> Canonical doc: [`PRE_RENDER_PIPELINE.md`](PRE_RENDER_PIPELINE.md)  
> Testy: `npm test` (unit + contracts) · `npm run test:e2e` (fixture pipeline + critic/fixer loop) — oba w CI

## Executive summary

**Ocena pre-render: 8.3/10** (cel: 9.5)

Pipeline analizy i reżyserii jest kompletny architektonicznie: 12 kroków, pełny graf artefaktów, walidatory V1–V23, agenci, fixture’y E2E, critic/fixer loop test, 155+ testów kontraktowych. Brakuje głównie **pełnego 12-krokowego E2E z mocked OpenAI** i **live vision/face** na realnym materiale.

---

## Scorecard (v3 → teraz → cel 9.5)

| Obszar | v3 | Teraz | Cel |
|--------|-----|-------|-----|
| Pipeline (12 kroków) | 8.0 | **8.7** | 9.5 |
| Video understanding | 6.5 | **7.8** | 9.5 |
| Index & abstrakcja | 8.0 | **8.3** | 9.5 |
| Agenci | 8.0 | **8.5** | 9.5 |
| EditRecipe (plan montażu) | 8.0 | **8.6** | 9.5 |
| Katalog technik | 8.0 | **8.2** | 9.5 |
| Walidacja | 8.5 | **8.8** | 9.5 |
| Fixture’y & testy | 7.5 | **8.4** | 9.5 |
| Dokumentacja | 7.0 | **8.2** | 9.5 |
| **Ogółem pre-render** | **7.8** | **8.3** | **9.5** |

---

## Co zbudowano (ta sesja)

### 4 subagenty równolegle

1. **E2E fixture’y** — `fixtures/batches/mini-day/`, `shorts-hook/` + `tests/e2e/pre-render-pipeline.test.js` + `npm run test:e2e`
2. **Graf artefaktów** — pełna invalidacja mtime (`artifact-deps.js`) + `docs/PRE_RENDER_PIPELINE.md`
3. **Face detect + raport jakości** — `python/face_detect.py`, `04a-faces-*`, `cli report --batch-id`, `10-batch-quality-report.json`
4. **Contract tests** — `tests/contracts/` (155 testów), golden recipe v2.2

### Naprawa integracji
- `golden-recipe-v2.json` + aliasy `topic-index.json` / `spatial-index.json`
- CI: `npm test` + `npm run test:e2e` + export-schemas drift check
- **405** testów unit/contract + **10** testów e2e

---

## 12 kroków — pełny plan przed montażem

| # | Krok | Artefakt | Co wiemy o wideo |
|---|------|----------|------------------|
| 1 | ingest | `00-manifest`, `00-scene-catalog` | pliki, sceny, metadane |
| 2 | transcribe | `01-words-*` | słowa, timestamps, fillery |
| 3 | keyframes | `02-keyframes-*` | klatki do ML |
| 4 | vision | `03-vision-*` | opisy wizualne (Qwen) |
| 5 | objects | `04-objects-*` | bbox, etykiety (Florence) |
| 6 | index | `05-timeline-index` | merge wszystkiego |
| 7 | clip_profile | `05a-clip-registry` | role klipów A-roll/B-roll |
| 8 | abstract | `06-abstract-L1/L2/L3` | streszczenia hierarchiczne |
| 9 | topic_index | `05b-topic-index` | tematy mowy → sceny B-roll |
| 10 | spatial_index | `05c-spatial-index`, `04a-faces-*` | kotwice twarz/temat |
| 11 | direct | `07-edit-recipe-draft` | plan montażu (AI) |
| 12 | review | `09-edit-recipe-final` | plan po krytyce/fixerze |

**Po pipeline:** `10-batch-quality-report.json` — metryki jakości batcha

**Face detect** = sub-krok w `spatial_index` (nie osobny krok CLI).

---

## EditRecipe — co zawiera plan montażu (bez renderu)

| Warstwa | Pola |
|---------|------|
| v2.0 | `outputs[]`, timeline, A/V refs, B-roll, `cuts[]`, `excluded`, `clipRegistry` |
| v2.1 | `creativityProfile`, `creativeMoments[]`, techniki z katalogu |
| v2.2 | `shortsRetentionProfile`, `retentionRole`, hook/beats, `textOverlays` style/role |
| Spatial | `spatialRef` — clipId, sceneId, bbox 0-1, anchorType |

**Brakuje do „pełnego planu”:** muzyka/ducking (audio-bed), SFX, color grade — deferred v2.3.

---

## Wszystkie opcje użytkownika

### CLI
`analyze` | `direct` | `run`/`full` | `report`  
`--input`, `--batch-id`, `--from-step`, `--to-step`, `--context`, `--min-outputs`, `--force`  
`--vision-live`, `--objects-stub`, `--no-objects`, `--no-keyframes`

### Context DSL (w `--context`)
`creativity: safe|balanced|bold|shorts`  
`shorts: retention` | `shorts: energy high`  
+ JSON batchContext: `brollStrategy`, `targetPlatforms`, `shortsMaxDurationSec`, …

### Packi technik
`youtube_vlog_2026`, `shorts_energy`, `shorts_retention_2026` — 30 technik w `techniques/`

---

## Droga do 9.5 (tylko pre-render)

| # | Zadanie | Wpływ | Status |
|---|---------|-------|--------|
| 1 | `test:e2e` w CI | Wysoki | **done** — `.github/workflows/test.yml` |
| 2 | E2E critic/fixer loop z mocked OpenAI | Bardzo wysoki | **done** — `tests/e2e/critic-fixer-loop.test.js` |
| 3 | `validateBrollTopicIndex` integration test | Średni | **done** — `recipe-v2-validator.test.js` |
| 4 | Dokumentacja fixture naming (mini-day) | Niski | **done** — `fixtures/batches/mini-day/README.md` |
| 5 | E2E 12 kroków z mocked OpenAI (abstract→review) | Bardzo wysoki | open |
| 6 | `--face-live` + dokumentacja face sub-step | Średni | open |
| 7 | Fixture’y z realistycznymi vision captions | Średni | open |
| 8 | Director pass-1: pełne L1 dla małych batchy | Średni | open |
| 9 | Dokumentacja pełnego batchContext DSL | Średni | open |
| 10 | 1 real batch (Whisper + Florence live) + raport | Wysoki | open |
| 11 | EditRecipe v2.3: audio-bed / ducking plan | Średni | open |
| 12 | Git commit + push | Ops | open |

---

## Dokumentacja kanoniczna

**[`docs/PRE_RENDER_PIPELINE.md`](PRE_RENDER_PIPELINE.md)** — pełny opis 12 kroków, flag, schematów, walidatorów, agent loop, mermaid.

```bash
npm test              # unit + contract tests (src/ + tests/, bez e2e)
npm run test:e2e      # fixture pipeline + critic/fixer loop (tests/e2e/)
node src/cli.js report --batch-id <id>
```

CI uruchamia oba: `npm test` → `npm run test:e2e` → `export-schemas` drift check.
