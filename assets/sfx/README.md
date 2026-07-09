# SFX library

Short audio clips for `sfxPlan` entries with `source: "library"`.

Katalog startuje **pusty** — dodawaj pliki z Pixabay skryptem ingest (jak muzyka).

## Workflow: Pixabay SFX

**Setup (raz, jeśli jeszcze nie):**

```bash
npm install
npm run setup:playwright
```

1. **Pobierz WAV/MP3 ręcznie** z Pixabay → `assets/sfx/`
2. **Uruchom ingest** (interaktywnie — tylko URL):

   ```bash
   node scripts/ingest-pixabay-sfx.js
   ```

   Skrypt szuka `{slug}.wav/.mp3` albo `*-{pixabayId}.*`, otwiera **widoczne Chromium**, parsuje Tags → `catalog.json`.

   ```bash
   node scripts/ingest-pixabay-sfx.js --url https://pixabay.com/sound-effects/fast-whoosh-123456/
   ```

3. Skrypt dopisuje też wiersz do [`LICENSES.md`](./LICENSES.md).

Skrót npm:

```bash
npm run ingest:pixabay-sfx
```

Opcje: `--headless`, `--dry-run`, `--force`, `--html`, `--tags-json`, `--captcha-wait-sec 300` (domyślnie **180s** na captcha — okno Chromium zostaje otwarte i polling co 2s).

## Catalog

Each entry in [`catalog.json`](./catalog.json):

- `sfxId` — stable ID (domyślnie `pixabay_sfx_<id>`)
- `fileName` — audio file in this folder
- `tags` — editorial tags (aligned with `src/editorial/audio-event-tags.js`)
- `category` — `transition` | `foley` | `reaction` | `ambience`
- `license` — `pixabay-content-license` (+ wpis w LICENSES.md)
- `pixabay.tags` — raw tags 1:1 ze strony

Resolution at render: `src/editorial/sfx-library.js` + `resolveSfxPath()` in `src/render/audio-mix.js`.

## AI opisy i tagi

Po ingeście uruchom (wymaga `OPENAI_API_KEY`):

```bash
npm run enrich:sfx-catalog
```

Domyślnie **text-only** (`gpt-5.4-nano`) — z tytułu, tagów Pixabay, LUFS. Odsłuch wymaga `--with-audio` i modelu `*-audio-preview` na koncie OpenAI.
- `description` — co słychać
- `tags` — tagi editorialne
- `useCases` — kiedy użyć w montażu
- `loudnessCharacter` — quiet | medium | loud

Opcje: `--sfx-id <id>`, `--force`, `--dry-run`, `--text-only` (bez audio, tańsze).
Model: `OPENAI_MODEL_SFX_ENRICH` (domyślnie `gpt-4o-mini-audio-preview`). Fallback tekstowy: `OPENAI_MODEL_SFX_ENRICH_TEXT` / `OPENAI_MODEL_NANO`.
