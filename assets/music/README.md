# Music library (pre-render)

Katalog startuje **pusty** — dodawaj utwory po pobraniu z Pixabay (patrz workflow poniżej). Pipeline używa `catalog.json` do wyboru `audioMixPlan.musicBed.trackId`.

**Music curator** (krok przed directorem): nano model wybiera `trackId` z shortlisty (~15 kandydatów) na podstawie L3 + tagów. Reżyser dostaje tylko `musicSelection` (jeden utwór), nie cały katalog.

## Workflow: dodawanie utworów z Pixabay

**Setup (raz):**

```bash
npm install
npm run setup:playwright
```

1. **Pobierz MP3 ręcznie** z Pixabay → `assets/music/`
2. **Uruchom ingest** (interaktywnie — podajesz tylko URL):

   ```bash
   node scripts/ingest-pixabay-music.js
   ```

   Skrypt szuka pliku `{slug-z-url}.mp3` albo `*-{pixabayId}.mp3`, potem **otwiera widoczne Chromium** i parsuje Genre/Mood/Movement/Theme (captcha — klikniesz w oknie).

   Jednolinijkowo:

   ```bash
   node scripts/ingest-pixabay-music.js --url https://pixabay.com/music/future-bass-no-copyright-music-537751/
   ```

3. **Skrypt:**
   - widoczne Chromium (Playwright) → parsuje Genre / Mood / Movement / Theme 1:1
   - dopisuje wpis do `catalog.json`
   - odpala analizę audio (BPM, beat grid, LUFS) na lokalnym pliku

Skrót npm:

```bash
npm run ingest:pixabay-music
```

### AI opisy (dla kuratora i reżysera)

Po ingeście:

```bash
npm run enrich:music-catalog
```

Dopisuje `description`, znormalizowane `mood`/`useCase`, `directorUseCases`, `suggestedBedVolumeDb` do `catalog.json`. Music curator i `musicSelection` w briefie directora korzystają z tych pól.

### Opcje

- `--headless` — bez okna (szybciej, Pixabay często blokuje)
- `--dry-run`, `--force`, `--track-id`, `--title`

### Escape hatch (bez przeglądarki)

```bash
node scripts/ingest-pixabay-music.js --html ~/Downloads/strona.html --url <link>
node scripts/ingest-pixabay-music.js --tags-json tags.json --url <link>
```
## Pola w `catalog.json`

- `trackId` — stable identifier referenced in EditRecipe v2.3 (domyślnie `pixabay_<id>`)
- `mood` — tags for `pickByMood()` / curator filter
- `useCase` — e.g. `shorts`, `vlog`, `youtube`
- `energy` — `low` | `medium` | `high`
- `pixabay` — optional raw tags: `genre`, `mood`, `movement`, `theme` (1:1 z Pixabay)
- `bpm` — beat sync hints for `cut_on_beat`
- `integratedLufs` — loudness reference for `calculateMusicGain()`
- `beatGrid` — opcjonalny cache beatów z `audio_analyze.py` (pipeline może też liczyć w locie)
