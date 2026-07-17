# Music library (pre-render)

Katalog startuje **pusty** — dodawaj utwory po pobraniu z Pixabay (patrz workflow poniżej). Pipeline używa `catalog.json` do wyboru `audioMixPlan.musicBed.trackId`.

**Music curator** (krok przed directorem): nano model wybiera `trackId` z shortlisty (~15 kandydatów) na podstawie L3 + tagów. Reżyser dostaje tylko `musicSelection` (jeden utór), nie cały katalog.

## Workflow: dodawanie utworów z Pixabay

**Setup (raz):**

```bash
npm install
npm run setup:playwright
cp .env.example .env   # OPENAI_API_KEY — wymagany (auto AI enrich po ingeście)
```

1. **Pobierz MP3 ręcznie** z Pixabay → `assets/music/`
2. **Uruchom ingest** (interaktywnie — podajesz tylko URL):

   ```bash
   npm run ingest:pixabay-music
   ```

   Skrypt szuka pliku `{slug-z-url}.mp3` albo `*-{pixabayId}.mp3`, potem **otwiera widoczne Chromium** i parsuje Genre/Mood/Movement/Theme (captcha — klikniesz w oknie).

   Jednolinijkowo:

   ```bash
   npm run ingest:pixabay-music -- --url https://pixabay.com/music/future-bass-no-copyright-music-537751/
   ```

3. **Skrypt automatycznie:**
   - widoczne Chromium (Playwright) → parsuje Genre / Mood / Movement / Theme 1:1
   - analizuje audio lokalnie (BPM, beat grid, LUFS) przez `audio_analyze.py`
   - dopisuje wpis do `catalog.json`
   - **uruchamia AI enrich** — `description`, `mood`, `directorUseCases`, `suggestedBedVolumeDb` (wymaga `OPENAI_API_KEY`)

Gotowy wpis jest od razu używalny przez music curatora i directora.

### Batch re-enrich (opcjonalnie)

Gdy chcesz odświeżyć opisy AI dla całego katalogu (np. po zmianie promptów):

```bash
npm run enrich:music-catalog
```

Domyślnie wzbogaca wpisy bez `description`. Z `--force` nadpisuje istniejące opisy.

### Opcje ingest

- `--skip-enrich` — pomiń AI enrich (tylko Pixabay + analiza audio)
- `--headless` — bez okna (szybciej, Pixabay często blokuje)
- `--dry-run` — podgląd wpisu bez zapisu i bez enrich
- `--force` — nadpisz istniejący `trackId` i wymuś ponowny AI enrich

### Escape hatch (bez przeglądarki)

```bash
npm run ingest:pixabay-music -- --html ~/Downloads/strona.html --url <link>
npm run ingest:pixabay-music -- --tags-json tags.json --url <link>
```

## Pola w `catalog.json`

- `trackId` — stable identifier referenced in EditRecipe v2.3 (domyślnie `pixabay_<id>`)
- `mood` — tags for `pickByMood()` / curator filter
- `useCase` — e.g. `shorts`, `vlog`, `youtube`
- `energy` — `low` | `medium` | `high`
- `pixabay` — optional raw tags: `genre`, `mood`, `movement`, `theme` (1:1 z Pixabay)
- `description` — opis AI (po polsku), do czego pasuje utwór
- `directorUseCases` — scenariusze montażowe dla directora
- `bpm` — beat sync hints for `cut_on_beat`
- `integratedLufs` — loudness reference for `calculateMusicGain()`
- `beatGrid` — opcjonalny cache beatów z `audio_analyze.py` (pipeline może też liczyć w locie)
- `suggestedBedVolumeDb` — sugerowana głośność tła (z AI enrich)
- `aiEnrichedAt` — timestamp ostatniego AI enrich
