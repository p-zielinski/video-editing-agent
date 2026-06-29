# SFX library

Short audio clips for `sfxPlan` entries with `source: "library"`.

## Catalog

Sounds are listed in [`catalog.json`](./catalog.json) (same pattern as [`assets/music/catalog.json`](../music/catalog.json)). Each entry has:

- `sfxId` — stable ID for Director / EditRecipe
- `fileName` — audio file in this folder
- `tags` — editorial tags (aligned with `src/editorial/audio-event-tags.js`)
- `license` — see [`LICENSES.md`](./LICENSES.md)

Bundled test asset: `whoosh.wav` (short sine burst, used by unit/E2E render tests).

## Adding a sound

1. Download from an approved source (CC0 / commercial-friendly). See [REQUIREMENTS_SFX_LIBRARY_AND_VOICEOVER.md](../../docs/REQUIREMENTS_SFX_LIBRARY_AND_VOICEOVER.md#źródła-dźwięków-licencje-komercyjne).
2. Normalize to a short WAV or MP3 (mono, 44.1 or 48 kHz).
3. Place the file in this folder.
4. Add an entry to `catalog.json` (`sfxId`, `fileName`, `tags`, `license`).
5. Fill in [`LICENSES.md`](./LICENSES.md) (source URL, license, download date).
6. Run `npm test -- tests/editorial/sfx-library.test.js`.

Resolution at render time: `src/editorial/sfx-library.js` + `resolveSfxPath()` in `src/render/audio-mix.js` (by `sfxId`, tag, or legacy `label` filename).
