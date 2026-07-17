# SFX library

Short audio clips for `sfxPlan` entries with `source: "library"`.

Katalog startuje **pusty** — dodawaj pliki z Pixabay skryptem ingest (jak muzyka).

## Workflow: Pixabay SFX

**Setup (raz, jeśli jeszcze nie):**

```bash
npm install
npm run setup:playwright
cp .env.example .env   # OPENAI_API_KEY — wymagany (auto AI enrich po ingeście)
```

1. **Pobierz WAV/MP3 ręcznie** z Pixabay → `assets/sfx/`
2. **Uruchom ingest** (interaktywnie — tylko URL):

   ```bash
   npm run ingest:pixabay-sfx
   ```

   Skrypt szuka `{slug}.wav/.mp3` albo `*-{pixabayId}.*`, otwiera **widoczne Chromium**, parsuje Tags → `catalog.json`.

   ```bash
   npm run ingest:pixabay-sfx -- --url https://pixabay.com/sound-effects/fast-whoosh-123456/
   ```

3. **Skrypt automatycznie:**
   - metadane Pixabay (tagi, kategoria) + pomiar LUFS
   - zapis `catalog.json` + wiersz w [`LICENSES.md`](./LICENSES.md)
   - **AI enrich** — opis „co słychać”, tagi editorialne, `useCases`, `loudnessCharacter` (domyślnie text-only z metadanych; wymaga `OPENAI_API_KEY`)

**Różnica kroków:** ingest = Pixabay + głośność; enrich = semantyczny opis efektu i kiedy go użyć w montażu (oba kroki łączy ingest domyślnie).

### Batch re-enrich (opcjonalnie)

```bash
npm run enrich:sfx-catalog
```

Wzbogaca wpisy bez pełnych opisów AI. Z `--force` nadpisuje istniejące.

### Opcje ingest

- `--skip-enrich` — pomiń AI enrich
- `--enrich-with-audio` — AI z odsłuchem pliku (wymaga modelu `*-audio-preview` na koncie OpenAI)
- `--headless`, `--dry-run`, `--force`, `--html`, `--tags-json`
- `--captcha-wait-sec 300` (domyślnie **180s** na captcha — okno Chromium zostaje otwarte i polling co 2s)

## Catalog

Each entry in [`catalog.json`](./catalog.json):

- `sfxId` — stable ID (domyślnie `pixabay_sfx_<id>`)
- `fileName` — audio file in this folder
- `tags` — editorial tags (aligned with `src/editorial/audio-event-tags.js`)
- `category` — `transition` | `foley` | `reaction` | `ambience`
- `license` — `pixabay-content-license` (+ wpis w LICENSES.md)
- `pixabay.tags` — raw tags 1:1 ze strony
- `description` — opis AI: co słychać i do czego pasuje
- `useCases` — scenariusze montażowe (np. przejście, payoff)
- `loudnessCharacter` — `quiet` | `medium` | `loud`
- `aiEnrichedAt` — timestamp ostatniego AI enrich

Resolution at render: `src/editorial/sfx-library.js` + `resolveSfxPath()` in `src/render/audio-mix.js`.

## AI enrich — zaawansowane

Domyślnie ingest uruchamia enrich w trybie **text-only** (`gpt-5.4-nano`) — z tytułu, tagów Pixabay i LUFS.

Odsłuch pliku przy enrich:

```bash
npm run ingest:pixabay-sfx -- --url <url> --enrich-with-audio
# lub batch:
npm run enrich:sfx-catalog -- --with-audio --sfx-id pixabay_sfx_88052
```

Model audio: `OPENAI_MODEL_SFX_ENRICH` (domyślnie `gpt-4o-mini-audio-preview`). Fallback tekstowy: `OPENAI_MODEL_SFX_ENRICH_TEXT` / `OPENAI_MODEL_NANO`.
