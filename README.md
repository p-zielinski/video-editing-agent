# Video Editing Agent

Analiza wideo i reżyseria AI — od surowych klipów do **EditRecipe** (receptury montażowej w JSON). Pipeline pre-render: transkrypcja, wizja lokalna, indeksy tematyczne/przestrzenne/audio, abstrakcja wielopoziomowa, director → critic/fixer.

**Ten projekt nie renderuje wideo.** Nie wykonuje cięć FFmpeg, nie eksportuje MP4 ani nie miksuje ścieżek audio. Artefakt końcowy to `09-edit-recipe-final.json` — plan montażu gotowy pod przyszły moduł renderu.

Kanoniczna referencja kroków, grafu zależności, schematów v2.0–v2.3 i DSL kontekstu: [`docs/PRE_RENDER_PIPELINE.md`](docs/PRE_RENDER_PIPELINE.md).

## Architektura (skrót)

```
inbox/*.MOV  →  [13 kroków analizy]  →  output/.work/<batchId>/
                                              ↓
                                    07-edit-recipe-draft.json
                                              ↓
                                    critic/fixer loop
                                              ↓
                                    09-edit-recipe-final.json
```

| Warstwa | Technologia | Rola |
|---------|-------------|------|
| Ingest / keyframes | Node + FFmpeg | manifest, sceny, klatki kluczowe |
| Transkrypcja | OpenAI Whisper | słowa, timery, fillery |
| Analiza audio | Python (librosa / ffmpeg astats) | beaty, energia, LUFS, `deadAirHints`, rekomendacja muzyki |
| Wizja | Python (Qwen2.5-VL / mlx-vlm) | opisy scen, jakość wizualna |
| Obiekty | Python (Florence-2) | detekcje obiektów/twarzy w klatkach |
| Face detect | Python (OpenCV) | bbox twarzy dla spatial index |
| Abstrakcja | GPT (summarizer) | L1/L2/L3 — od scen do narracji batcha |
| Reżyseria | GPT (director) | EditRecipe v2 z technikami montażowymi |
| Walidacja | Zod + reguły V21/V22/V23 | critic/fixer, golden recipes |

Szczegóły kroków, mtime-cache i `batchContext`: [`docs/PRE_RENDER_PIPELINE.md`](docs/PRE_RENDER_PIPELINE.md).

## Wymagania

- Node.js 20+
- ffmpeg / ffprobe (ścieżki opcjonalnie w `.env`)
- `OPENAI_API_KEY` w `.env`
- Python 3.9+ z `pip install -r python/requirements.txt`
  - **Florence-2** (objects) — live domyślnie
  - **librosa** (audio_analysis) — live domyślnie
  - **mlx-vlm** (vision/Qwen) — live domyślnie
  - **opencv-python-headless** (face detect) — live domyślnie; opcjonalne w `requirements.txt`
  - **panns_inference** (audio events) — opcjonalne; zalecane dla tagów śmiechu/uderzeń (`editorialTags`) w `05d-audio-index`

## Szybki start

```bash
cp .env.example .env   # uzupełnij OPENAI_API_KEY
npm install
pip install -r python/requirements.txt
```

Umieść pliki wideo w `inbox/<folder>/`, potem:

```bash
# Pełny pipeline (analiza + reżyseria + review)
npm run full -- --input ./inbox/moj-folder --context "vlog dzień 66/100"

# Tylko analiza (ingest → index) — bez kosztów GPT director/critic
npm run analyze -- --input ./inbox/moj-folder

# Reżyseria na gotowym batchu (abstract → review)
npm run direct -- --batch-id abc12345 --context "vlog dzień 66/100"

# Wznowienie od wybranego kroku
node src/cli.js run --batch-id abc12345 --from-step topic_index --force
```

Artefakty: `output/.work/<batchId>/`. Finalna receptura: `09-edit-recipe-final.json` (tylko po przejściu walidacji).

**Szybki dev bez GPU/Pythona:** dodaj `--fast` (stuby vision/face/audio) lub jawne flagi `--vision-stub`, `--face-stub`, `--audio-stub`.

## Struktura katalogów

| Ścieżka | Opis |
|---------|------|
| `inbox/` | Wejściowe pliki wideo (folder przekazywany przez `--input`) |
| `output/.work/<batchId>/` | Artefakty pipeline per batch |
| `fixtures/batches/` | Gotowe work-diry do testów (np. `mini-day`, `shorts-hook`) |
| `techniques/` | Katalog zabiegów montażowych (`catalog.meta.json` + JSON per technika) |
| `prompts/v1/`, `prompts/v2/` | Prompty agentów (director, critic, fixer, summarizer) |
| `schemas/json/` | Eksportowane schematy JSON (EditRecipe, indeksy, …) |
| `python/` | Skrypty scene_detect, vision, objects, face_detect, audio_analyze |
| `src/` | Orchestrator, kroki pipeline, agenci, walidatory |

## Etapy pipeline (13 kroków)

`ingest` → `transcribe` → `audio_analysis` → `keyframes` → `vision` → `objects` → `index` → `clip_profile` → `abstract` → `topic_index` → `spatial_index` → `direct` → `review`

### Artefakty

| Plik | Krok | Zawartość |
|------|------|-----------|
| `00-manifest.json` | ingest | metadane batcha, `artifactMtimes` |
| `00-scene-catalog.json` | ingest | granice scen per klip |
| `01-words-<clipId>.json` | transcribe | WordIndex (Whisper) |
| `01b-audio-analysis-<clipId>.json` | audio_analysis | energia, beaty, cisza per klip |
| `02-keyframes-<clipId>.json` | keyframes | ścieżki klatek kluczowych |
| `03-vision-<clipId>.json` | vision | opisy Qwen per klatka |
| `04-objects-<clipId>.json` | objects | detekcje Florence-2 |
| `04a-faces-<clipId>.json` | spatial_index | bbox twarzy (face detect) |
| `05-timeline-index.json` | index | TimelineIndex — sceny, słowa, wizja, detekcje |
| `05a-clip-registry.json` | clip_profile | role klipów (A-roll, B-roll pool, outtakes) |
| `05b-topic-index.json` | topic_index | tematy mowy → sceny B-roll |
| `05c-spatial-index.json` | spatial_index | kotwice przestrzenne (twarz/subject/bbox) |
| `05d-audio-index.json` | audio_analysis | LUFS głosu, beaty, cisza, `deadAirHints` (w briefie), rekomendacja muzyki |
| `06-abstract-L*.json` | abstract | Abstrakcje L1/L2/L3 |
| `07-edit-recipe-draft.json` | direct | EditRecipe v2.1/v2.2/v2.3 (draft) |
| `08-review.json` | review | wynik critic/fixer |
| `09-edit-recipe-final.json` | review | finalna receptura po walidacji |

### Warstwy danych → brief directora

Director (`buildDirectorBrief` w `src/agents/director.js`) dostaje skondensowany brief z poniższych artefaktów:

| Artefakt | Co trafia do directora |
|----------|------------------------|
| `05-timeline-index.json` | `sceneMap`, `fillerStats`, **`transcriptExcerpts`** (słowa A-roll z `wordId`/timerami, max 80/scena) |
| `06-abstract.json` | `sessionSummary` (L3), `segmentSummaries` (L2), pola L1 w `sceneMap` (`brollPotential`, `topics`, `visualQuality`, `stability`) |
| `05a-clip-registry.json` | `clipRegistry`, `excludedHints` (outtakes, wykluczenia) |
| `05b-topic-index.json` | `topicIndex` — dopasowanie tematów do B-roll (v2.0: embedding + keyword) |
| `05c-spatial-index.json` | `spatialIndex` (skrót), `spatialRefExamples` dla `creativeMoments` |
| `05d-audio-index.json` | `audioIndex` (skrót: **`beatTimestamps`**, `deadAirHints`, cutSuggestions, silenceGaps per klip), `audioMixDefaults` |
| `techniques/` | `techniqueCatalog` — dozwolone zabiegi i budżet |
| `--context` / orchestrator | `batchContext`, `userContext`, `creativityProfile`, `shortsRetentionProfile` |

## Domyślne tryby: live vs stub

**Bez flag CLI vision, face i audio są LIVE** (pełna analiza Python). Stuby włączają się tylko z `--fast` lub jawnymi flagami `--*-stub`.

| Krok | Domyślnie (bez flag) | `--fast` | Jawny stub | Wymuszenie live |
|------|----------------------|----------|------------|-----------------|
| Vision (Qwen2.5-VL) | **live** | stub | `--vision-stub` | `--vision-live` |
| Face detect | **live** | stub¹ | `--face-stub` | `--face-live` |
| Audio analysis | **live** | stub | `--audio-stub` | *(domyślnie live)* |
| Objects (Florence-2) | **live** | **live**² | `--objects-stub` | *(domyślnie live)* |
| Scene detection | **live** | **live** | — | — |
| Keyframes | **włączone** | **włączone** | `--no-keyframes` | — |

¹ Przy `--fast` face jest stubem, chyba że dodasz `--face-live`.  
² `--fast` nie wyłącza Florence-2 — tylko `--objects-stub` lub `--no-objects`.

Logika w `src/cli.js` (linie 278–281):

```javascript
faceStub: args.faceStub === true || (args.fast === true && args.faceLive !== true),
visionStub: args.visionStub === true || (args.fast === true && args.visionLive !== true),
audioStub: args.audioStub === true || args.fast === true,
objectsStub: args.objectsStub === true,
```

## Konfiguracja (.env, Python, FFmpeg)

Skopiuj `.env.example` → `.env`:

| Zmienna | Opis |
|---------|------|
| `OPENAI_API_KEY` | Wymagany dla transcribe, abstract, direct, review |
| `OPENAI_MODEL_NANO` / `OPENAI_MODEL_MINI` | Modele GPT (domyślnie gpt-5.5-nano / gpt-5.5-mini) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Opcjonalne ścieżki do binarek |
| `PYTHON_VENV` | Opcjonalny venv dla skryptów Python |

Zależności Python: `pip install -r python/requirements.txt` (zawiera `opencv-python-headless` do live detekcji twarzy oraz opcjonalne `panns_inference` do tagów śmiechu/uderzeń). Przy starcie pipeline uruchamia preflight (`checkPythonPreflight`) — brak wymaganych pakietów kończy się błędem w trybie live; przy stubach pojawia się ostrzeżenie. Brak OpenCV przy live face (`--face-live` / domyślnie) loguje ostrzeżenie — `face_detect.py` wróci do stub bbox. Brak PANNs przy live audio loguje ostrzeżenie — `audio_events.py` zwróci `eventDetectionMode: "none"` bez tagów editorial.

## EditRecipe v2 — podsumowanie wersji

Receptura montażowa z rozdzielonymi ścieżkami audio/wideo. Migracja v1→v2: `src/lib/migrate-recipe-v1-v2.js`.

### v2.0 — fundament

- `clipRegistry` — role plików (`aroll_primary`, `broll_pool`, `outtakes`, …)
- Segmenty z `videoRef` + `audioRef` (cross-clip B-roll)
- `segmentRole`: `aroll` | `broll`
- `excluded` z typami `whole_clip` | `scene` | `time_range`
- `outputKind`: `main` | `short` (shorty jako standalone highlights, max 60s)
- `inputMode`: `single_clip` (1 plik) lub `multi_clip_day` (2+ plików) — wykrywane automatycznie

### v2.1 — warstwa kreatywności

- `creativityProfile` — poziom montażu (`safe` | `balanced` | `bold` | `shorts`), pack technik, `allowMidSentenceCuts`
- `creativeMoments[]` — zabiegi z katalogu `techniques/` (zoom, cięcia, przejścia, overlay)
- Domyślny pack: `youtube_vlog_2026`
- Walidacja: kody V21-01 … V21-13 (`src/validators/creative-moments.js`), m.in. V21-12 (`music_swell` + `musicBed`), V21-13 (`silence_beat` vs cisza)

Kształt `spatialRef` w `creativeMoments`:

```json
{
  "clipId": "clip01",
  "sceneId": "clip01_scene001",
  "anchorType": "subject",
  "bbox": [0.1, 0.2, 0.5, 0.6],
  "timestampSec": 5.0
}
```

Wymagane: `clipId` + `sceneId` + (`timestampSec` **lub** `bbox` + `anchorType`). Helpery: `src/editorial/spatial-ref.js`.

### v2.2 — gramatyka retencji shortów

Dla `outputKind: "short"`:

- `shortsRetentionProfile` — hook window, cadence beatów, wymagania overlay
- `creativeMoments[].retentionRole` — `hook` | `beat` | `payoff`
- `textOverlays[].style` / `role` — hook_large, emphasis, chapter_card; role `hook`, `retention_beat`, `cta`

**Opt-in:** retention domyślnie wyłączone. Włącza się gdy:
- `requiredFormats` to wyłącznie short (np. samo `9:16`) lub istnieje output `outputKind: "short"`,
- `creativityProfile.level === "shorts"`,
- `--context` zawiera `shorts: retention` lub `shorts: energy high`,
- lub jawne `shortsRetentionProfile.enabled: true`.

**Nie włącza się** przy domyślnym `16:9,9:16`. Wyłączenie: `shortsRetentionProfile.enabled: false`.

Pack: `shorts_retention_2026`. Walidacja: V22-01 … V22-07 (`src/validators/shorts-retention.js`).

### v2.3 — plan miksowania audio (pre-render)

Opcjonalne `audioMixPlan` — plan LUFS, muzyki bed i duckingu **bez wykonania miksu** w tym pipeline:

- `voiceTargetLufs` / `preWhisperNormalizeLufs` — domyślnie -16 / -18 LUFS
- `musicBed` — zewnętrzna ścieżka (`trackId`, `volumeDb`, `duckingDb`) lub `null`
- `segments[]` — per `outputId`: `musicInSec`, `musicOutSec`, `duckUnderVoice`

Gdy `musicBed` jest ustawione, segmenty powinny mieć `audioPolicy: "external"` (warning **V23-01**). Szczegóły: [`docs/PRE_RENDER_PIPELINE.md#editrecipe-v23--plan-miksowania-audio-pre-render`](docs/PRE_RENDER_PIPELINE.md#editrecipe-v23--plan-miksowania-audio-pre-render).

## Context DSL (`--context`)

Tekst wolny trafia do `batchContext.notes`. Tokeny parsowane regexem:

| Token | Efekt |
|-------|--------|
| `creativity: safe` \| `balanced` \| `bold` \| `shorts` | `creativityProfile.level` |
| `shorts: energy high` | pack `shorts_energy`, gęstość montażu; opcjonalnie retention |
| `shorts: retention` | włącza `shortsRetentionProfile`, pack `shorts_retention_2026` |

Tokeny łącz średnikiem lub przecinkiem. Gdy `--context` zaczyna się od `{`, parsowany jest jako JSON i merge'owany z `batchContext` (pełna tabela pól Zod: [`docs/PRE_RENDER_PIPELINE.md#batchcontext--pola-zod`](docs/PRE_RENDER_PIPELINE.md#batchcontext--pola-zod)).

Przykłady:

```bash
node src/cli.js run --input ./inbox/day-66 --context "vlog day 66; creativity: bold"
node src/cli.js direct --batch-id abc12345 --context 'shorts: retention; {"shortsMaxDurationSec":45}'
```

## Idempotencja i wznawianie

Kroki pomijają istniejące artefakty, jeśli upstream się nie zmienił (`src/pipeline/artifact-deps.js`). `--force` wymusza przebudowę.

**Stale spatial index:** gdy `05-timeline-index.json` lub `04-objects-*.json` są nowsze niż `05c-spatial-index.json`, spatial index jest automatycznie przebudowywany (również przy `--from-step direct` przez `ensureSpatialIndex`).

Po kroku `index` katalog scen (`00-scene-catalog.json`) jest wzbogacany o `hasSpeech` i `wordRange`.

### Raport jakości batcha

Po analizie (lub na gotowym work-dir) zmierz pokrycie danych dla reżysera:

```bash
node src/cli.js report --batch-id <batchId>
# lub: npm start -- report --batch-id <batchId>
```

Zapisuje `10-batch-quality-report.json` i wypisuje m.in.:
- **anchor coverage** / face anchors (% scen z kotwicami spatial)
- **filler ratio** i liczbę słów mowy
- **topic match rate** (% tematów z dopasowaniem B-roll ≥ `brollMatchThreshold` z recipe → manifest → domyślnie `0.55`)
- metryki audio (LUFS, beaty, cisza)
- **`needsHumanReview`** gdy nie przejdzie którejś bramki jakości: anchor coverage < 50%, topic match < 50%, L1 `brollPotential` < 80%, błędy walidacji recipe — lista w `qualityGateFailures`

Przykład na fixture `mini-day`:

```bash
cp -R fixtures/batches/mini-day output/.work/mini-day-report
node src/cli.js report --batch-id mini-day-report
```

Live batch (vision + objects): `npm run analyze -- --input ./inbox/moj-folder` → `report --batch-id <id>`.

Szczegółowa checklista live batch (wymagania, komendy, bramki jakości): [`docs/LIVE_BATCH_CHECKLIST.md`](docs/LIVE_BATCH_CHECKLIST.md).

## Topic index v2 (embeddingi)

Krok `topic_index` używa **OpenAI `text-embedding-3-small`** gdy `OPENAI_API_KEY` jest ustawiony:
- wersja artefaktu **2.0** — blend 50% keyword + 50% cosine similarity embeddingów
- bez klucza lub z `stub: true` w testach — **1.0** (sam keyword overlap)

Implementacja: `src/pipeline/steps/topic-index.js`, `embedTexts()` w `src/agents/openai-client.js`.

## Testy i fixture'y

```bash
npm test              # unit + contract (~492 testów, src/ + tests/)
npm run test:e2e      # 12 testów E2E (w tym 1× full-pipeline mocked mini-day)
```

Bez librosa analiza audio wraca do **`ffmpeg_astats`** (`analysisMode` w `01b`) — cisza/RMS OK, beaty często puste.

| Fixture | Scenariusz |
|---------|------------|
| `fixtures/batches/mini-day/` | Multi-clip vlog (A-roll + B-roll), golden recipe v2.0/v2.2 |
| `fixtures/batches/shorts-hook/` | Short z hookiem, retention |

Contract tests: `tests/contracts/` (schematy agentów, katalog technik, golden recipe). Szczegóły fixture'ów: `fixtures/batches/*/README.md`.

## Roadmap

| Status | Zakres |
|--------|--------|
| **Gotowe** | Pre-render: 13 kroków analizy, indeksy, abstrakcja, director/critic/fixer, EditRecipe v2.0–v2.3, walidacja V21/V22/V23 |
| **Przyszłość** | Moduł renderu FFmpeg — cięcia, przejścia, overlay, miks audio według `audioMixPlan` |
