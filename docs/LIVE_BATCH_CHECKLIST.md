# Checklist: live batch

> Ostatnia aktualizacja: 2026-06-26  
> Kanoniczny pipeline: [`PRE_RENDER_PIPELINE.md`](PRE_RENDER_PIPELINE.md)

Checklist przed i po uruchomieniu **pełnego** batcha na prawdziwych klipach (bez stubów). Cel: upewnić się, że artefakty analizy są wystarczające dla directora i że receptura przechodzi bramki jakości.

## Wymagania wstępne

| Wymaganie | Opis |
|-----------|------|
| **Node.js 20+** | `npm install` w katalogu projektu |
| **ffmpeg / ffprobe** | W `PATH` lub ścieżki w `.env` (`FFMPEG_PATH`, `FFPROBE_PATH`) |
| **Python 3.9+** | `pip install -r python/requirements.txt` |
| **OPENAI_API_KEY** | W `.env` — Whisper, embeddingi topic index, agenci GPT |
| **GPU (opcjonalnie)** | Przyspiesza vision (Qwen/mlx-vlm) i Florence-2; bez GPU batch działa, ale wolniej |
| **Miejsce na dysku** | Keyframes + artefakty JSON w `output/.work/<batchId>/` |

Zależności Pythona używane w trybie live (domyślnie):

- **librosa** — analiza audio (beaty, energia, LUFS)
- **mlx-vlm** — opisy scen (Qwen2.5-VL)
- **Florence-2** — detekcje obiektów
- **opencv-python-headless** — face detect (spatial index)
- **panns_inference** (opcjonalnie, zalecane) — tagi audio (`laughter`, `impact`) dla hooków i `sceneRanks`; bez niego `eventDetectionMode: none`

Szybki dev bez GPU/Pythona: jawne `--vision-stub`, `--face-stub`, `--audio-stub` (nie dotyczy checklisty live).

## Komendy

### 1. Analiza (bez kosztów director/critic)

```bash
cp .env.example .env   # uzupełnij OPENAI_API_KEY
npm install
pip install -r python/requirements.txt

# Klipy w inbox/
npm run analyze -- --input ./inbox/moj-folder
```

Kroki: `ingest` → `index` (transkrypcja, audio, keyframes, twelvelabs stub, vision, objects, timeline index).  
Artefakty: `output/.work/<batchId>/`.

### 2. Raport jakości

```bash
node src/cli.js report --batch-id <batchId>
```

Zapisuje `10-batch-quality-report.json` i wypisuje podsumowanie na stdout. Uruchom **po analizie** (lub po pełnym pipeline), zanim zatwierdzisz batch do reżyserii.

### 3. Pełny pipeline (analiza + reżyseria + review)

```bash
npm run full -- --input ./inbox/moj-folder --context "vlog dzień 66/100"
```

Alternatywnie w dwóch fazach:

```bash
npm run analyze -- --input ./inbox/moj-folder
npm run direct -- --batch-id <batchId> --context "vlog dzień 66/100"
```

Finalna receptura (po przejściu walidacji): `09-edit-recipe-final.json`.

## Jak czytać `10-batch-quality-report.json`

Plik: `output/.work/<batchId>/10-batch-quality-report.json`.

### `metrics.qualityGateFailures`

Tablica kodów bramek, które **nie** zostały spełnione. Pusta tablica = wszystkie bramki OK.

| Kod | Znaczenie | Typowa przyczyna |
|-----|-----------|------------------|
| `anchor_coverage_below_50` | Mniej niż 50% scen ma kotwice w spatial index | Brak twarzy w kadrze, wyłączony face detect, słabe keyframes |
| `topic_match_rate_below_50` | Mniej niż 50% tematów ma dopasowanie B-roll ≥ próg | Słaba mowa, brak wizualnego B-roll, niski embedding match |
| `l1_fields_present_below_80` | Mniej niż 80% scen ma `brollPotential` w L1 | Nieukończony krok `abstract` lub błąd summarizera |
| `recipe_validation_errors` | Walidacja EditRecipe v2 zgłasza błędy (`severity: error`) | Problemy w draft/final recipe (scene registry, B-roll, V21/V22) |

Próg dopasowania tematów (`topicMatchThreshold`) pochodzi z recipe → manifest → domyślnie `0.55`.

### Inne pola w `metrics` (skrót)

- **anchorCoveragePercent** / **faceAnchorPercent** — pokrycie kotwicami spatial
- **fillerRatio** — udział słów-fillerów w transkrypcji
- **topicMatchRate** — % tematów z sensownym dopasowaniem scen
- **l1FieldsPresentPercent** — % scen z wypełnionym `brollPotential`
- **validationErrorCount** / **validationWarningCount** — wynik walidacji recipe
- **needsHumanReview** — patrz sekcja poniżej
- **Audio (stdout):** LUFS, beaty, `totalSilenceSec` — z `05d-audio-index`. **`deadAirHints`** nie są osobną metryką raportu; powstają w briefie directora/critica (`fuseDeadAirHints`: RMS `silenceGaps` + przerwy między słowami Whisper, `source: both` = najpewniejsze cięcie). Sprawdź w `05d-audio-index.json` per klip (`silenceGaps`) i w `07-edit-recipe-draft.json` czy segmenty nie obejmują długich hintów bez cięcia.

## Szacunkowe czasy i koszty

Wartości orientacyjne dla **jednego** batcha vlogowego (~10–20 min materiału, 2–4 klipy), tryb **live**:

| Faza | Czas (CPU / GPU) | Koszt API (szacunek) |
|------|------------------|----------------------|
| Transkrypcja (Whisper) | 2–8 min | ~$0.05–0.20 |
| Vision + objects | 15–60 min / 5–15 min | — (lokalnie) |
| Audio analysis | 1–3 min | — |
| Abstract (L1–L3) | 1–3 min | ~$0.10–0.40 |
| Director + critic/fixer | 2–8 min | ~$0.30–1.50 |
| **Razem** | **~30–90 min** (zależy od GPU i liczby scen) | **~$0.50–2.50** |

`npm run analyze` bez `direct` omija koszty director/critic. Embeddingi topic index (v2) to dodatkowe wywołania OpenAI — zwykle ułamek kosztu abstract.

## Kiedy `needsHumanReview: yes`

Pole `metrics.needsHumanReview` w raporcie jest `true`, gdy spełniony jest **którykolwiek** warunek:

1. **`qualityGateFailures` nie jest puste** — nie spełniono którejś bramki (patrz tabela powyżej).
2. **`recipe.needsHumanReview`** — ustawione przez pętlę critic/fixer (np. nierozwiązane błędy, odrzucona receptura).
3. **`08-review.json` z `approved: false`** — critic nie zatwierdził receptury po iteracjach.

**Co robić:** przejrzyj `08-review.json` (issues), `07-edit-recipe-draft.json` vs `09-edit-recipe-final.json`, oraz metryki w raporcie. Popraw kontekst (`--context`), uruchom ponownie `--from-step` (np. `spatial_index`, `abstract`, `direct`) lub ręcznie edytuj recepturę przed renderem.

Gdy `needsHumanReview: no` i `qualityGateFailures: []` — batch jest gotowy do użycia receptury `09-edit-recipe-final.json` (`npm run render -- --batch-id <id>`).

### Super Director (długie batchy)

Gdy materiał ma **> 600 s** łącznie lub **> 1 segment L2**, krok `direct` używa Super Director (routing L2 → segment directors → merge). Krótsze batchy idą pojedynczym directorem. Sprawdź `06-abstract-L2.json` i log kroku `direct`.

## Review (`08-review.json`)

Po `direct` / `full` przejrzyj issues z critic/fixer. Typowe **warningi audio (v2.1)** — nie blokują same z siebie `needsHumanReview`, ale fixer powinien je naprawić gdy sensowne:

| Kod | Znaczenie | Co sprawdzić |
|-----|-----------|--------------|
| **V21-11** | `cut_on_beat` daleko od beatu w `audioIndex` | Beaty per klip w `05d`; tolerancja `snapToleranceSec` |
| **V21-12** | `music_swell` bez `audioMixPlan.musicBed` | Draft recipe — dodaj `musicBed` z katalogu lub usuń moment |
| **V21-13** | `silence_beat` poza `silenceGap` / `cutSuggestion` | Porównaj z `deadAirHints` i `silenceGaps` w briefie; kotwica w tolerancji `durationSec` |

Przy braku librosa Python zwraca `analysisMode: "ffmpeg_astats"` — beaty mogą być puste lub mniej wiarygodne; V21-11/V21-13 opieraj się na `silenceGaps` i fuzji dead air, nie na beat_track.

## Szybka ścieżka weryfikacji na fixture

```bash
cp -R fixtures/batches/mini-day output/.work/mini-day-live-check
node src/cli.js report --batch-id mini-day-live-check
```

Oczekiwane: `needsHumanReview: no`, puste `qualityGateFailures` (przy kompletnym fixture).
