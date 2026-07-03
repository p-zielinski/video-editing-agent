# Video Editing Agent

Analiza wideo, reżyseria AI i **montaż FFmpeg** — od surowych klipów do gotowych MP4. Pipeline: transkrypcja, wizja, indeksy, director → critic/fixer → **render**.

Artefakt pre-render: `09-edit-recipe-final.json`. Po `node src/cli.js render --batch-id <id>` otrzymujesz MP4 w `output/.work/<batchId>/renders/`.

Kanoniczna referencja kroków, grafu zależności, schematów v2.0–v2.3 i DSL kontekstu: [`docs/PRE_RENDER_PIPELINE.md`](docs/PRE_RENDER_PIPELINE.md).  
Formaty odpowiedzi AI, EditRecipe i gotowość do montażu: [`docs/FORMATY_AI_I_GOTOWOSC_MONTAZU.md`](docs/FORMATY_AI_I_GOTOWOSC_MONTAZU.md).

## Architektura (skrót)

```
inbox/*.MOV  →  [14 kroków analizy]  →  output/.work/<batchId>/
                                              ↓
                                    07-edit-recipe-draft.json
                                              ↓
                                    critic/fixer loop
                                              ↓
                                    09-edit-recipe-final.json
                                              ↓
                                    render (FFmpeg) → MP4
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
| **Render** | FFmpeg (`src/render/`) | MP4 16:9 + 9:16 z receptury |
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

# Produkcja: więcej iteracji critic/fixer (domyślnie 3)
npm run full -- --input ./inbox/moj-folder --context "vlog" --max-review-iterations 5

# Montaż z gotowej receptury → MP4
npm run render -- --batch-id abc12345
npm run render -- --batch-id abc12345 --output-id horizontal_main --encode-profile draft

# Iteracja renderu (pomiń passy / wznów po błędzie / preset)
npm run render -- --batch-id abc12345 --render-profile preview --force
npm run render -- --batch-id abc12345 --from-pass creative --keep-tmp

# Re-enrich bez GPT (po zmianie indeksów lub ręcznej edycji draftu)
node src/cli.js enrich --batch-id abc12345 --source draft --target final --force

# One-shot: pipeline + render
node src/cli.js run --input ./inbox/day --context "vlog" --render --render-profile preview
```

```bash
# Wznowienie od wybranego kroku pipeline (nie renderu)
node src/cli.js run --batch-id abc12345 --from-step topic_index --force
```

Artefakty: `output/.work/<batchId>/`. Finalna receptura: `09-edit-recipe-final.json` (tylko po przejściu walidacji).

**Domyślnie vision, face i audio są zawsze LIVE** — pełna analiza Python. Stuby (`--vision-stub`, `--face-stub`, `--audio-stub`) tylko w testach CI lub gdy świadomie chcesz pominąć GPU/Python.

## Struktura katalogów

| Ścieżka | Opis |
|---------|------|
| `inbox/` | Wejściowe pliki wideo (folder przekazywany przez `--input`) |
| `output/.work/<batchId>/` | Artefakty pipeline per batch |
| `fixtures/batches/` | Gotowe work-diry do testów (np. `mini-day`, `shorts-hook`) |
| `techniques/` | Katalog zabiegów montażowych (`catalog.meta.json` + JSON per technika) |
| `prompts/v1/`, `prompts/v2/` | Prompty agentów (director, super-director, critic, fixer, summarizer) |
| `schemas/json/` | Eksportowane schematy JSON (EditRecipe, indeksy, …) |
| `python/` | Skrypty scene_detect, vision, objects, face_detect, audio_analyze |
| `src/` | Orchestrator, kroki pipeline, agenci, walidatory |
| `assets/sfx/` | Katalog SFX dla `sfxPlan` (`catalog.json`); pliki w repo to **testowe stuby** (`license: repo-generated-test-stub`) — źródła i licencje w [`assets/sfx/LICENSES.md`](assets/sfx/LICENSES.md) |

## Etapy pipeline (14 kroków)

`ingest` → `transcribe` → `audio_analysis` → `keyframes` → `twelvelabs` → `vision` → `objects` → `index` → `clip_profile` → `abstract` → `topic_index` → `spatial_index` → `direct` → `review`

(opcjonalnie poza główną ścieżką: `thumbnails`)

### Artefakty

| Plik | Krok | Zawartość |
|------|------|-----------|
| `00-manifest.json` | ingest | metadane batcha, `artifactMtimes` |
| `00-scene-catalog.json` | ingest | granice scen per klip |
| `01-words-<clipId>.json` | transcribe | WordIndex (Whisper) |
| `01b-audio-analysis-<clipId>.json` | audio_analysis | energia, beaty, cisza per klip |
| `02-keyframes-<clipId>.json` | keyframes | ścieżki klatek kluczowych |
| `03b-twelvelabs-<clipId>.json` | twelvelabs | rozdziały, momenty, podsumowanie klipu (TwelveLabs lub stub) |
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
| `13-render-manifest.json` | render | manifest montażu (ścieżki MP4, ostrzeżenia) |
| `renders/*.mp4` | render | wyeksportowane wideo per output |

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

### Super Director (routing dla długich batchy)

Gdy łączny czas materiału **> 600 s** lub jest **więcej niż jeden segment L2**, krok `direct` używa ścieżki **Super Director** zamiast pojedynczego directora:

1. **Super Director** (`prompts/v2/super-director.md`) — wybiera max 10 segmentów L2 i planuje narrację między nimi.
2. **Segment Director** — buduje częściowe receptury per segment L2.
3. **Merge** (`src/lib/recipe-merge.js`) — skleja częściowe receptury w jeden `07-edit-recipe-draft.json`.

Krótkie batchy (≤ 600 s i jeden segment L2) omijają Super Director i idą klasyczną ścieżką `runDirector` + drill-down.

## Domyślne tryby: live vs stub

**Bez flag CLI vision, face i audio są LIVE** (pełna analiza Python). Stuby włączają się tylko jawnymi flagami `--*-stub` (głównie testy CI).

| Krok | Domyślnie (bez flag) | Jawny stub | Wymuszenie live |
|------|----------------------|------------|-----------------|
| Vision (Qwen2.5-VL) | **live** | `--vision-stub` | `--vision-live` |
| Face detect | **live** | `--face-stub` | `--face-live` |
| Audio analysis | **live** | `--audio-stub` | *(domyślnie live)* |
| Objects (Florence-2) | **live** | `--objects-stub` | *(domyślnie live)* |
| Scene detection | **live** | — | — |
| Keyframes | **włączone** | `--no-keyframes` | — |
| TwelveLabs | **stub** (domyślnie) | `--twelvelabs-stub` | `--twelvelabs-live` (wymaga `TWELVELABS_API_KEY`; live API jeszcze niezaimplementowane — fallback do stub) |

Logika w `src/cli.js`:

```javascript
faceStub: args.faceStub === true,
visionStub: args.visionStub === true,
audioStub: args.audioStub === true,
objectsStub: args.objectsStub === true,
```

> **Uwaga:** flaga `--fast` została usunięta (produkcyjny pipeline zawsze live). Użyj jawnych stubów tylko w testach.

## Konfiguracja (.env, Python, FFmpeg)

Skopiuj `.env.example` → `.env`:

| Zmienna | Opis |
|---------|------|
| `OPENAI_API_KEY` | Wymagany dla transcribe, abstract, direct, review |
| `OPENAI_MODEL_NANO` / `OPENAI_MODEL_MINI` | Modele GPT (domyślnie gpt-5.5-nano / gpt-5.5-mini) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Opcjonalne ścieżki do binarek |
| `TWELVELABS_API_KEY` | Opcjonalny — wymagany dla `--twelvelabs-live` (live API jeszcze niezaimplementowane) |
| `PYTHON_VENV` | Opcjonalny venv dla skryptów Python |

Zależności Python: `pip install -r python/requirements.txt` (zawiera `opencv-python-headless` do live detekcji twarzy oraz opcjonalne `panns_inference` do tagów śmiechu/uderzeń). Przy starcie pipeline uruchamia preflight (`checkPythonPreflight`) — brak wymaganych pakietów kończy się błędem w trybie live; przy stubach pojawia się ostrzeżenie. Brak OpenCV przy live face (`--face-live` / domyślnie) loguje ostrzeżenie — `face_detect.py` wróci do stub bbox. Brak PANNs przy live audio loguje ostrzeżenie — `audio_events.py` zwróci `eventDetectionMode: "none"` bez tagów editorial.

## EditRecipe v2 — podsumowanie wersji

Receptura montażowa z rozdzielonymi ścieżkami audio/wideo. Migracja v1→v2: `src/lib/migrate-recipe-v1-v2.js`.

### v2.0 — fundament

- `clipRegistry` — role plików (`aroll_primary`, `broll_pool`, `outtakes`, …)
- Segmenty z `videoRef` + `audioRef` (cross-clip B-roll)
- `videoTransform.speed` / `speedMode` (`video_audio` | `video_only`) — przyspieszenie wideo i opcjonalnie audio (`setpts` / `atempo`)
- `sourceVolumeDb` — korekta głośności źródła per segment (dB → filtr `volume`)
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

Opcjonalne `audioMixPlan` — plan LUFS, muzyki bed i duckingu; **autorowany w pre-render**, **wykonywany w rendererze** (`npm run render`):

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

## Topic index v2 (embeddingi — wymagane)

Krok `topic_index` **zawsze** używa embeddingów (`text-embedding-3-small` przez `OPENAI_API_KEY`):
- wersja artefaktu **2.0** — blend 50% keyword + 50% cosine similarity embeddingów
- bez `OPENAI_API_KEY` krok kończy się błędem `TopicIndexEmbeddingError` (brak cichego fallbacku na keyword-only v1.0)
- w testach: jawny `embedFn` (np. `createTokenVectorEmbedFn()`)

Po L1 summarizer uruchamia się **post-L1 clip role refinement** (`roleSource: l1_refined`) przed budową topic index.

Implementacja: `src/pipeline/steps/topic-index.js`, `src/pipeline/steps/clip-profile.js`, `embedTexts()` w `src/agents/openai-client.js`.

## Testy i fixture'y

```bash
npm test              # unit + contract + E2E
npm run test:e2e      # testy E2E (orchestrator mocked bez OPENAI_API_KEY gdy brak klucza)
```

Bez librosa analiza audio wraca do **`ffmpeg_astats`** (`analysisMode` w `01b`) — cisza/RMS OK, beaty często puste.

| Fixture | Scenariusz |
|---------|------------|
| `fixtures/batches/mini-day/` | Multi-clip vlog (A-roll + B-roll), golden recipe v2.0/v2.2 |
| `fixtures/batches/shorts-hook/` | Short z hookiem, retention |

Contract tests: `tests/contracts/` (schematy agentów, katalog technik, golden recipe). Szczegóły fixture'ów: `fixtures/batches/*/README.md`.

## Roadmap

Kontrakt renderu i plan zamknięcia luk: [`docs/RENDER_MODULE_SPEC.md`](docs/RENDER_MODULE_SPEC.md), [`docs/LUKI_PLAN_NAPRAWCZY.md`](docs/LUKI_PLAN_NAPRAWCZY.md).

| Status | Zakres |
|--------|--------|
| **Gotowe** | Pre-render + render FFmpeg: analiza, EditRecipe v2.0–v2.4, montaż 16:9/9:16, ASS, overlaye, creativeMoments, audioMixPlan, speed/volume per segment |
| **W toku** | J/L-cut frame-accurate, [katalog SFX + VO](docs/REQUIREMENTS_SFX_LIBRARY_AND_VOICEOVER.md) |
