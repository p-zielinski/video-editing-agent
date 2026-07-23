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
| Transkrypcja | OpenAI Whisper + safety classifier | słowa, timery, fillery, kontekstowa brand-safety PL, korekta `expectedTerms` |
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
- Python 3.9+ z `pip3 install -r python/requirements.txt`
  - **mlx-vlm** (vision), **Florence-2** (objects), **librosa** (audio), **parselmouth** (prozodia / F0), **opencv-python-headless** (face)
  - **panns_inference** (opcjonalnie) — tagi śmiechu/uderzeń w analizie audio

## Szybki start

```bash
cp .env.example .env   # uzupełnij OPENAI_API_KEY
npm install
pip3 install -r python/requirements.txt
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

## Biblioteka audio (muzyka i SFX)

Pipeline korzysta z lokalnych katalogów `assets/music/` i `assets/sfx/` (muzyka tła, efekty w `sfxPlan`). Nowe utwory i efekty dodajesz z Pixabay jednym skryptem ingest — metadane strony (Playwright), analiza audio (BPM/LUFS) i **automatyczny AI enrich** (opis, use cases) w jednym przebiegu.

**Setup (raz):**

```bash
npm install
npm run setup:playwright   # Chromium do metadanych Pixabay
cp .env.example .env       # OPENAI_API_KEY — wymagany przy ingeście (auto enrich)
pip3 install -r python/requirements.txt   # librosa — BPM/beat grid dla muzyki
```

**Workflow (muzyka):**

1. Pobierz MP3 z Pixabay → `assets/music/`
2. Uruchom ingest (interaktywnie lub z URL):

```bash
npm run ingest:pixabay-music
# lub:
npm run ingest:pixabay-music -- --url https://pixabay.com/music/...
```

Skrypt: widoczne Chromium → Genre/Mood/Movement/Theme → analiza audio → zapis `catalog.json` → **AI enrich** nowego wpisu.

**Workflow (SFX):**

1. Pobierz WAV/MP3 z Pixabay → `assets/sfx/`
2. Uruchom ingest:

```bash
npm run ingest:pixabay-sfx
# lub:
npm run ingest:pixabay-sfx -- --url https://pixabay.com/sound-effects/...
```

Skrypt: metadane Pixabay → LUFS → `catalog.json` + wiersz w `LICENSES.md` → **AI enrich** (domyślnie text-only z tytułu i tagów).

**Przydatne flagi ingest:**

| Flaga | Opis |
|-------|------|
| `--skip-enrich` | Tylko metadane Pixabay + analiza audio, bez AI |
| `--dry-run` | Podgląd wpisu bez zapisu i bez enrich |
| `--force` | Nadpisz istniejący wpis i wymuś ponowny AI enrich |
| `--enrich-with-audio` | *(tylko SFX)* AI z odsłuchem pliku (`*-audio-preview`) |

**Batch re-enrich całego katalogu** (gdy zmienisz prompty lub dodasz wiele plików ręcznie):

```bash
npm run enrich:music-catalog
npm run enrich:sfx-catalog
```

Szczegóły pól katalogu: [`assets/music/README.md`](assets/music/README.md), [`assets/sfx/README.md`](assets/sfx/README.md).

**Profile analizy:** `--analysis-profile preview|production|ci` ustawia zestaw stubów (jawne flagi `--vision-stub` itd. mają pierwszeństwo). `ci` = preview + wyłączony globalny cache.

**AI video:** `--ai-video` włącza krok `ai_video` (Kling VIDEO 3.0); po wygenerowaniu live klip jest analizowany przez TwelveLabs i trafia do briefu Directora jako rzeczywisty asset. Błąd analizy nie usuwa hooka, ale oznacza go jako niezweryfikowany. `--ai-video-stub` sam włącza krok w jawnym trybie placeholdera lavfi. Brak kluczy nie uruchamia stuba automatycznie.

**Dwa niezależne cache:**

| Warstwa | Domyślnie | Flaga |
|---------|-----------|-------|
| **Artefakty kroków** (`06-abstract.json` itd.) | Pomijaj krok, gdy artefakt świeży | `--force` — przelicz mimo świeżego artefaktu |
| **Odpowiedzi LLM** (`llm-cache/*.json`) | Zawsze świeże wywołanie API, gdy krok się wykonuje | `--reuse-llm-cache` — opt-in reuse (np. po ręcznej poprawce odrzuconej odpowiedzi) |

Każde wywołanie `chatJson` zapisuje surową odpowiedź w `llm-cache/`. Przy odrzuceniu Zod powstaje `*__rejected.json`. Reuse LLM tylko przez `--reuse-llm-cache` (nie `.env`).

**Abstract L1 poison:** przy `--from-step abstract` zepsuty `06-abstract.json` jest wykrywany przez integrity gate, llm-cache L1/L2 czyszczony i krok przebudowywany **bez `--force`**. `--force` zostaw na pełne przeliczenie, gdy integrity przechodzi, a chcesz i tak od nowa.

## Struktura katalogów

| Ścieżka | Opis |
|---------|------|
| `inbox/` | Wejściowe pliki wideo (folder przez `--input`) |
| `output/.work/<batchId>/` | Artefakty pipeline per batch |
| `fixtures/batches/` | Gotowe work-diry do testów (`mini-day`, `shorts-hook`, `voiceover-day`) |
| `fixtures/whisper-audit/` | Case'y benchmarku Whisper |
| `config/profanity-pl.json` | Lista słów dla tagowania wulgaryzmów (PL) |
| `config/safety/content-safety-pl.json` | Kontekstowa taksonomia PL: przemoc, przestępstwa, nadużycia, ataki i neutralne tożsamości chronione |
| `techniques/` | Katalog zabiegów montażowych |
| `prompts/v2/` | **Kanoniczne** prompty agentów (director, super-director, critic, fixer, summarizer) |
| `prompts/v1/` | Legacy — nie używane przez bieżący pipeline |
| `schemas/json/` | Schematy JSON (EditRecipe, indeksy, …) |
| `python/` | Skrypty scene_detect, vision, objects, face_detect, audio_analyze |
| `src/` | Orchestrator, kroki pipeline, agenci, walidatory, render |
| `assets/music/` | Biblioteka muzyki tła — `catalog.json` + pliki MP3 (Pixabay) |
| `assets/sfx/` | Biblioteka efektów dźwiękowych — `catalog.json` + pliki audio (Pixabay) |

## Context DSL

Tokeny w `--context` i pola JSON — szczegóły w [`docs/PIPELINE.md`](docs/PIPELINE.md#context-dsl) i [`docs/CONTEXT.md`](docs/CONTEXT.md):

```bash
node src/cli.js run --input ./inbox/day-66 --context "vlog day 66; creativity: bold"
node src/cli.js direct --batch-id abc12345 --context 'shorts: retention; {"shortsMaxDurationSec":45}'
node src/cli.js run --input ./inbox/gaming --context '{"expectedTerms":["Elden Ring"],"profanityPolicy":"bleep"}'
```

| Pole | Skrót |
|------|-------|
| `profanityPolicy` | kompatybilny override audio: `bleep` (domyślnie), `mute`, `cut`, `off` |
| `brandSafety` | domyślnie włączona polityka dla audio, napisów, overlayów, tytułów, miniatur, publish text i excerptów LLM; neutralne określenia grup nie są cenzurowane bez szkodliwego kontekstu |
| `expectedTerms` | nazwy własne dla Whisper prompt i korekty tokenów po transkrypcji |
| `aiVideoEnabled` | `true` + `--ai-video` — hook Kling dla shortów |
| `skipDrillDown` | `true` — pomija drugi pass directora (drill-down) |
| `forceClassicDirector` | `true` — wymusza klasycznego directora zamiast Super Director na długich batchach |

**Review:** `--strict-review` wymaga `approved` od krytyka przed zapisem `09-edit-recipe-final.json` (nawet gdy walidacja Zod przechodzi).

## Konfiguracja (.env)

| Zmienna | Opis |
|---------|------|
| `OPENAI_API_KEY` | Wymagany dla transcribe, abstract, direct, review, embeddingi |
| `OPENAI_MODEL_NANO` / `OPENAI_MODEL_MINI` / `OPENAI_MODEL_FLAGSHIP` | Bazowe poziomy modeli GPT (domyślnie gpt-5.4-nano / gpt-5.4-mini / gpt-5.4) |
| `OPENAI_MODEL_SUMMARIZER_L1/L2/L3` | Routing abstrakcji: domyślnie nano / mini / flagship |
| `OPENAI_MODEL_DIRECTOR` / `OPENAI_MODEL_SUPER_DIRECTOR` | Globalne decyzje reżyserskie; domyślnie flagship |
| `OPENAI_MODEL_SEGMENT_DIRECTOR` / `OPENAI_MODEL_DIRECTOR_DRILLDOWN` | Lokalne drafty i dopracowanie; domyślnie mini |
| `OPENAI_MODEL_CRITIC` / `OPENAI_MODEL_FIXER` / `OPENAI_MODEL_FIXER_ESCALATION` | Review i naprawa: mini, a druga próba Fixera — flagship |
| `OPENAI_MODEL_SAFETY_CLASSIFIER` | Klasyfikacja tylko niejednoznacznych kontekstów brand-safety (domyślnie mini) |
| `OPENAI_QUOTA_TRACKING` | Włącza dzienny licznik tokenów w `output/.openai-usage/daily/` |
| `OPENAI_MODEL_DOWNGRADE_ENABLED` | Runtime router: po wyczerpaniu puli premium obniża tier (np. director → mini) |
| `OPENAI_DAILY_PREMIUM_LIMIT` / `OPENAI_DAILY_MINI_LIMIT` | Limity darmowych pul (domyślnie 250k / 2.5M tokenów) |
| `OPENAI_WHISPER_MODEL` | Model Whisper (domyślnie `whisper-1`) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Opcjonalne ścieżki do binarek |
| `TWELVELABS_API_KEY` | Opcjonalny — rozdziały i momenty klipu (stub: `--twelvelabs-stub`) |
| `TWELVELABS_INDEX_ID` | Opcjonalny — ID indexu TwelveLabs |
| `KLING_ACCESS_KEY` | Kling API — klucz z panelu (`api-key-kling-...`); krok `ai_video` |
| `KLING_VIDEO_MODEL` | Model wideo Kling (domyślnie `kling-v3`, czyli VIDEO 3.0) |
| `AI_VIDEO_STUB=1` | Jawny placeholder AI video bez wywołania Kling; nie jest automatycznym fallbackiem |
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
