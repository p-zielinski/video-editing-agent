# Music library (pre-render)

Placeholder catalog for `audioMixPlan.musicBed.trackId` selection. Binary MP3 files are optional for analysis/tests — the pipeline uses `catalog.json` for mood/BPM matching.

Add tracks under this folder and register them in `catalog.json`:

- `trackId` — stable identifier referenced in EditRecipe v2.3
- `mood` — tags for `pickByMood()`
- `bpm` — beat sync hints for `cut_on_beat`
- `integratedLufs` — loudness reference for `calculateMusicGain()`
