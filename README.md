# Video Editing Agent

Analiza wideo, reżyseria AI i montaż FFmpeg — od surowych klipów do gotowych MP4.

Pipeline: transkrypcja → meta-komendy → wizja → indeksy → director → critic/fixer → miniatury → publish → render.

Artefakt pre-render: `09-edit-recipe-final.json`. Po `npm run render -- --batch-id <id>` otrzymujesz MP4 w `output/.work/<batchId>/renders/`.

**Dokumentacja:** [`docs/PIPELINE.md`](docs/PIPELINE.md) — kroki, artefakty, receptura, cache, render. [`docs/CONTEXT.md`](docs/CONTEXT.md) — pola `batchContext`. [`docs/RECIPE-VERSIONS.md`](docs/RECIPE-VERSIONS.md) — wersje EditRecipe 2.x.

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
                                    thumbnails + publish (opcjonalnie)
                                              ↓
                                    render (FFmpeg) → MP4
```

| Warstwa | Technologia | Rola |
|---------|-------------|------|
| Ingest / keyframes | Node + FFmpeg | manifest, sceny, klatki kluczowe |
| Transkrypcja | OpenAI Whisper | słowa, timery, fillery, profanity, korekta `expectedTerms` |
| Meta-komendy | reguły PL | boomerang, overlay daty, reverse z transkryptu |
| Analiza audio | Python (librosa) | beaty, energia, LUFS, cisza |
| Wizja | Python (Qwen2.5-VL) | opisy scen, jakość wizualna |
| Obiekty | Python (Florence-2) | detekcje obiektów/twarzy |
| Face detect | Python (OpenCV) | bbox twarzy dla spatial index |
| Abstrakcja | GPT (summarizer) | L1/L2/L3 — od scen do narracji batcha |
| Reżyseria | GPT (director) | EditRecipe — plan montażowy |
| Miniatury | GPT + Sharp | plan wariantów, PNG w `thumbnails/` |
| Publish | deterministyczny | `15-publish-package-*.json` — tytuł, opis, tagi |
| Render | FFmpeg (`src/render/`) | MP4 16:9 + 9:16 @ 1080p z receptury |
| AI video hooks | Kling API (opcjonalnie) | krótki hook first/last frame dla shortów |
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
# Pełny pipeline (analiza + reżyseria + review + miniatury + publish)
npm run full -- --input ./inbox/moj-folder --context "vlog dzień 66/100"
# alias: npm run pipeline (to samo co full)

# Tylko analiza — bez kosztów GPT director/critic (domyślnie do clip_profile)
npm run analyze -- --input ./inbox/moj-folder

# Pełna reżyseria: direct (na gotowym batchu) lub full / pipeline (analiza + reżyseria)
# analyze nie uruchamia abstract/direct — tylko indeksy i clip registry

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
node src/cli.js report --batch-id abc12345 --quality-profile production

# Diagnostyka work dir (stale cache, needsHumanReview, provenance)
node src/cli.js doctor --batch-id abc12345

# Benchmark transkrypcji Whisper (fixture'y w fixtures/whisper-audit/ — szczegóły: fixtures/whisper-audit/README.md)
npm run benchmark:whisper
npm run benchmark:whisper:fixture
```

Artefakty: `output/.work/<batchId>/`. Finalna receptura: `09-edit-recipe-final.json`. Audyt zmian receptury: `14-recipe-provenance.json`. Zużycie tokenów GPT: `16-gpt-usage.json` (kroki m.in. `abstract`, `direct`, `drill_down`, `super_director`, `segment_director`, `super_critic`, `critic`, `fixer`). Pakiety publikacji: `15-publish-package-<outputId>.json`.

**Domyślnie vision, face i audio są LIVE** — pełna analiza Python. Stuby (`--vision-stub`, `--face-stub`, `--audio-stub`) tylko w testach CI.

**Profile analizy:** `--analysis-profile preview|production|ci` ustawia zestaw stubów (jawne flagi `--vision-stub` itd. mają pierwszeństwo). `ci` = preview + wyłączony globalny cache.

**AI video:** `--ai-video` włącza krok `ai_video` (Kling); `--ai-video-stub` lub `AI_VIDEO_STUB=1` — lavfi bez API.

## Struktura katalogów

| Ścieżka | Opis |
|---------|------|
| `inbox/` | Wejściowe pliki wideo (folder przez `--input`) |
| `output/.work/<batchId>/` | Artefakty pipeline per batch |
| `fixtures/batches/` | Gotowe work-diry do testów (`mini-day`, `shorts-hook`, `voiceover-day`) |
| `fixtures/whisper-audit/` | Case'y benchmarku Whisper |
| `config/profanity-pl.json` | Lista słów dla tagowania wulgaryzmów (PL) |
| `techniques/` | Katalog zabiegów montażowych |
| `prompts/v2/` | **Kanoniczne** prompty agentów (director, super-director, critic, fixer, summarizer) |
| `prompts/v1/` | Legacy — nie używane przez bieżący pipeline |
| `schemas/json/` | Schematy JSON (EditRecipe, indeksy, …) |
| `python/` | Skrypty scene_detect, vision, objects, face_detect, audio_analyze |
| `src/` | Orchestrator, kroki pipeline, agenci, walidatory, render |
| `assets/sfx/` | Katalog SFX dla `sfxPlan` — pliki w repo to testowe stuby |

## Context DSL

Tokeny w `--context` i pola JSON — szczegóły w [`docs/PIPELINE.md`](docs/PIPELINE.md#context-dsl) i [`docs/CONTEXT.md`](docs/CONTEXT.md):

```bash
node src/cli.js run --input ./inbox/day-66 --context "vlog day 66; creativity: bold"
node src/cli.js direct --batch-id abc12345 --context 'shorts: retention; {"shortsMaxDurationSec":45}'
node src/cli.js run --input ./inbox/gaming --context '{"expectedTerms":["Elden Ring"],"profanityPolicy":"bleep"}'
```

| Pole | Skrót |
|------|-------|
| `profanityPolicy` | `bleep` (domyślnie), `mute`, `cut`, `off` — tagowanie w transcribe + enricher w recepturze |
| `expectedTerms` | nazwy własne dla Whisper prompt i korekty tokenów po transkrypcji |
| `aiVideoEnabled` | `true` + `--ai-video` — hook Kling dla shortów |
| `skipDrillDown` | `true` — pomija drugi pass directora (drill-down) |
| `forceClassicDirector` | `true` — wymusza klasycznego directora zamiast Super Director na długich batchach |

**Review:** `--strict-review` wymaga `approved` od krytyka przed zapisem `09-edit-recipe-final.json` (nawet gdy walidacja Zod przechodzi).

## Konfiguracja (.env)

| Zmienna | Opis |
|---------|------|
| `OPENAI_API_KEY` | Wymagany dla transcribe, abstract, direct, review, embeddingi |
| `OPENAI_MODEL_NANO` / `OPENAI_MODEL_MINI` | Modele GPT (domyślnie gpt-5.4-nano / gpt-5.4-mini) |
| `OPENAI_MODEL_DIRECTOR` / `OPENAI_MODEL_CRITIC` | Opcjonalne nadpisanie modelu dla directora i krytyka/fixer (fallback: `OPENAI_MODEL_MINI`) |
| `OPENAI_WHISPER_MODEL` | Model Whisper (domyślnie `whisper-1`) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Opcjonalne ścieżki do binarek |
| `TWELVELABS_API_KEY` | Opcjonalny — rozdziały i momenty klipu (stub: `--twelvelabs-stub`) |
| `TWELVELABS_INDEX_ID` | Opcjonalny — ID indexu TwelveLabs |
| `KLING_ACCESS_KEY` / `KLING_SECRET_KEY` | Kling API (`kling-v2-6`) — krok `ai_video` (domyślnie wyłączony) |
| `KLING_VIDEO_MODEL` | Model wideo Kling (domyślnie `kling-v2-6`) |
| `AI_VIDEO_STUB=1` | Stub AI video bez wywołania Kling |
| `PYTHON_VENV` | Opcjonalny venv dla skryptów Python |
| `CLIP_CONCURRENCY` | Równoległe klipy w analizie (domyślnie `2`) |
| `GPU_CONCURRENCY` | Równoległość vision/objects/face (domyślnie `1`) |
| `SEGMENT_DIRECTOR_CONCURRENCY` | Równoległe wywołania segment directora w Super Director (domyślnie `3`) |
| `PIPELINE_STRICT_REVIEW=1` | Dla `run`/`full`: włącza `--strict-review` (wymaga `approved` od krytyka przed `09-edit-recipe-final.json`) |
| `DISABLE_GLOBAL_ANALYSIS_CACHE=1` | Wyłącza globalny cache analizy cross-batch |

## Render — wybrane flagi

```bash
npm run render -- --batch-id abc12345 --encode-profile draft
npm run render -- --batch-id abc12345 --from-pass creative --keep-tmp
```

| Flaga | Opis |
|-------|------|
| `--encode-profile draft\|production` | Jakość kodowania (domyślnie production) |
| `--from-pass` | Wznów od passu: `concat`, `creative`, `subs`, `overlays`, `audio_mix`, `color_grade` |
| `--render-profile` | Preset passów: `preview`, `iterate`, `production` |

## Testy

```bash
npm test              # unit + contract + E2E
npm run test:e2e      # testy E2E
npm run benchmark:whisper:fixture   # audyt Whisper na fixture'ach (bez live API)
```

Fixture'y: `fixtures/batches/mini-day/` (multi-clip vlog), `fixtures/batches/shorts-hook/` (short z hookiem), `fixtures/batches/voiceover-day/` (narracja).
