# Video Editing Agent

Analiza wideo, reżyseria AI i montaż FFmpeg — od surowych klipów do gotowych MP4.

Pipeline: transkrypcja → wizja → indeksy → director → critic/fixer → render.

Artefakt pre-render: `09-edit-recipe-final.json`. Po `npm run render -- --batch-id <id>` otrzymujesz MP4 w `output/.work/<batchId>/renders/`.

**Dokumentacja:** [`docs/PIPELINE.md`](docs/PIPELINE.md) — pełny opis kroków, artefaktów, receptury, cache i renderu.

## Architektura

```
inbox/*.MOV  →  [analiza + reżyseria]  →  output/.work/<batchId>/
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
| Analiza audio | Python (librosa) | beaty, energia, LUFS, cisza |
| Wizja | Python (Qwen2.5-VL) | opisy scen, jakość wizualna |
| Obiekty | Python (Florence-2) | detekcje obiektów/twarzy |
| Face detect | Python (OpenCV) | bbox twarzy dla spatial index |
| Abstrakcja | GPT (summarizer) | L1/L2/L3 — od scen do narracji batcha |
| Reżyseria | GPT (director) | EditRecipe — plan montażowy |
| Render | FFmpeg (`src/render/`) | MP4 16:9 + 9:16 z receptury |
| Walidacja | Zod + reguły | critic/fixer, golden recipes |

## Wymagania

- Node.js 20+
- ffmpeg / ffprobe (ścieżki opcjonalnie w `.env`)
- `OPENAI_API_KEY` w `.env`
- Python 3.9+ z `pip install -r python/requirements.txt`
  - **mlx-vlm** (vision), **Florence-2** (objects), **librosa** (audio), **opencv-python-headless** (face)
  - **panns_inference** (opcjonalnie) — tagi śmiechu/uderzeń w analizie audio

## Szybki start

```bash
cp .env.example .env   # uzupełnij OPENAI_API_KEY
npm install
pip install -r python/requirements.txt
```

Umieść pliki wideo w `inbox/<folder>/`:

```bash
# Pełny pipeline (analiza + reżyseria + review)
npm run full -- --input ./inbox/moj-folder --context "vlog dzień 66/100"

# Tylko analiza — bez kosztów GPT director/critic
npm run analyze -- --input ./inbox/moj-folder

# Reżyseria na gotowym batchu
npm run direct -- --batch-id abc12345 --context "vlog dzień 66/100"

# Montaż z gotowej receptury → MP4
npm run render -- --batch-id abc12345

# One-shot: pipeline + render
node src/cli.js run --input ./inbox/day --context "vlog" --render --render-profile preview

# Wznowienie od wybranego kroku
node src/cli.js run --batch-id abc12345 --from-step topic_index --force

# Re-enrich bez GPT (po zmianie indeksów lub ręcznej edycji draftu)
node src/cli.js enrich --batch-id abc12345 --source draft --target final --force

# Raport jakości batcha
node src/cli.js report --batch-id abc12345
```

Artefakty: `output/.work/<batchId>/`. Finalna receptura: `09-edit-recipe-final.json`.

**Domyślnie vision, face i audio są LIVE** — pełna analiza Python. Stuby (`--vision-stub`, `--face-stub`, `--audio-stub`) tylko w testach CI.

**Profile analizy:** `--analysis-profile preview|production|ci` ustawia zestaw stubów (jawne flagi `--vision-stub` itd. mają pierwszeństwo). `ci` = preview + wyłączony globalny cache.

## Struktura katalogów

| Ścieżka | Opis |
|---------|------|
| `inbox/` | Wejściowe pliki wideo (folder przez `--input`) |
| `output/.work/<batchId>/` | Artefakty pipeline per batch |
| `fixtures/batches/` | Gotowe work-diry do testów (`mini-day`, `shorts-hook`, `voiceover-day`) |
| `techniques/` | Katalog zabiegów montażowych |
| `prompts/v2/` | Prompty agentów (director, super-director, critic, fixer, summarizer) |
| `schemas/json/` | Schematy JSON (EditRecipe, indeksy, …) |
| `python/` | Skrypty scene_detect, vision, objects, face_detect, audio_analyze |
| `src/` | Orchestrator, kroki pipeline, agenci, walidatory, render |
| `assets/sfx/` | Katalog SFX dla `sfxPlan` — pliki w repo to testowe stuby |

## Context DSL

Tokeny w `--context` (szczegóły w [`docs/PIPELINE.md`](docs/PIPELINE.md#context-dsl)):

```bash
node src/cli.js run --input ./inbox/day-66 --context "vlog day 66; creativity: bold"
node src/cli.js direct --batch-id abc12345 --context 'shorts: retention; {"shortsMaxDurationSec":45}'
```

## Konfiguracja (.env)

| Zmienna | Opis |
|---------|------|
| `OPENAI_API_KEY` | Wymagany dla transcribe, abstract, direct, review, embeddingi |
| `OPENAI_MODEL_NANO` / `OPENAI_MODEL_MINI` | Modele GPT (domyślnie gpt-5.5-nano / gpt-5.5-mini) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Opcjonalne ścieżki do binarek |
| `TWELVELABS_API_KEY` | Opcjonalny — rozdziały i momenty klipu (stub: `--twelvelabs-stub`) |
| `TWELVELABS_INDEX_ID` | Opcjonalny — ID indexu TwelveLabs |
| `PYTHON_VENV` | Opcjonalny venv dla skryptów Python |
| `DISABLE_GLOBAL_ANALYSIS_CACHE=1` | Wyłącza globalny cache analizy cross-batch |

## Testy

```bash
npm test              # unit + contract + E2E
npm run test:e2e      # testy E2E
```

Fixture'y: `fixtures/batches/mini-day/` (multi-clip vlog), `fixtures/batches/shorts-hook/` (short z hookiem), `fixtures/batches/voiceover-day/` (narracja).
