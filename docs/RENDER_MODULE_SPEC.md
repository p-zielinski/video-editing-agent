# Render module specification

> Last updated: 2026-06-26  
> Status: **scaffold** (pre-FFmpeg)  
> Related: [`LUKI_PLAN_NAPRAWCZY.md`](./LUKI_PLAN_NAPRAWCZY.md) W1, [`EDITING_RECIPE_V2_SPEC.md`](./EDITING_RECIPE_V2_SPEC.md) §14

## Purpose

The render module bridges **analysis artifacts** and a future **FFmpeg renderer**. It does not encode video today. It defines:

1. How batch work-dir files and `EditRecipe` resolve to concrete paths.
2. An **EDL** (edit decision list) per output.
3. Helpers for **9:16 reframe** and **style presets**.

## Module layout

| File | Role |
|------|------|
| `src/render/resolve-render-context.js` | Load `00-scene-catalog.json`, `01-words-*.json`; map `clipId` → paths; resolve `audioMixPlan.musicBed` |
| `src/render/build-render-edl.js` | Build per-output EDL from `buildOutputTimeline()` + context |
| `src/render/reframe.js` | `computeReframeCrop()` — normalized crop box for target format |
| `src/render/style-presets.js` | `DEFAULT_RENDER_STYLE_PRESETS` for subtitles and overlays |

## Inputs

### Work directory (`workDir`)

Typical layout (from pipeline `output/.work/<batchId>/`):

```
workDir/
  00-scene-catalog.json    # clipId → sourcePath, resolution
  01-words-<clipId>.json   # WordIndex per clip (subtitles)
  09-edit-recipe-final.json  # EditRecipe v2.x (passed separately)
```

Raw video lives at paths from `sceneCatalog.clips[].sourcePath` (often under `inbox/`).

### Recipe (`recipe`)

`EditRecipe` v2.0–2.4 with `outputs[]`, optional `audioMixPlan`, `creativeMoments`, `renderStylePresets` (v2.4+).

### `resolveRenderContext(workDir, recipe)`

Returns:

```json
{
  "batchId": "miniday1",
  "clips": {
    "clip01": {
      "sourcePath": "/inbox/01_talk.MOV",
      "fileName": "01_talk.MOV",
      "resolution": { "w": 1920, "h": 1080 }
    }
  },
  "wordIndexes": {
    "clip01": { "clipId": "clip01", "words": [] }
  },
  "musicBed": {
    "trackId": "upbeat_vlog_01",
    "volumeDb": -18,
    "track": { "trackId": "...", "fileName": "..." },
    "trackFilePath": "/abs/path/assets/music/upbeat_vlog_01.mp3",
    "resolveReason": null
  },
  "sceneCatalog": { }
}
```

`musicBed` is `null` when `audioMixPlan.musicBed` is absent. When `trackId` is set but the file is missing, `track` is `null` and `resolveReason` is `track_not_in_catalog` or `track_file_missing`.

## EDL format

`buildRenderEdl(output, recipe, context)` produces:

```json
{
  "outputId": "horizontal_main",
  "format": "16:9",
  "durationSec": 50,
  "segments": [
    {
      "segmentId": "seg_h1",
      "videoSourcePath": "/inbox/01_talk.MOV",
      "audioSourcePath": "/inbox/01_talk.MOV",
      "videoInSec": 0,
      "videoOutSec": 30,
      "audioInSec": 0,
      "audioOutSec": 30,
      "audioPolicy": "from_video_ref",
      "outputStartSec": 0,
      "outputEndSec": 30,
      "cuts": []
    }
  ]
}
```

### Segment fields

| Field | Source | Notes |
|-------|--------|-------|
| `videoSourcePath` | `context.clips[videoRef.clipId].sourcePath` | B-roll or A-roll video file |
| `audioSourcePath` | Policy-dependent | See below |
| `videoInSec` / `videoOutSec` | Segment | Source trim range (seconds) |
| `audioInSec` / `audioOutSec` | Segment | Audio trim range |
| `audioPolicy` | Segment | `from_video_ref`, `from_audio_ref`, `from_prev`, `from_next`, `external` |
| `outputStartSec` / `outputEndSec` | `buildOutputTimeline()` | Position on master output timeline |
| `cuts` | Segment | Word-level audio cuts (applied before concat) |

### Audio source resolution

| `audioPolicy` | `audioSourcePath` |
|---------------|-------------------|
| `from_video_ref` | Same clip as `videoRef` |
| `from_audio_ref` | `audioRef.clipId` clip |
| `from_prev` / `from_next` | `videoRef` or `audioRef` clip (J/L-cut scaffold) |
| `external` | `context.musicBed.trackFilePath` |

## Reframe (`computeReframeCrop`)

Input:

```js
computeReframeCrop({
  format: "9:16",
  spatialAnchor: { bbox: [x, y, w, h], anchorType: "face" },
  sourceResolution: { w: 1920, h: 1080 },
});
```

Output: normalized crop box `{ x, y, w, h }` in 0–1 coordinates.

- **16:9** source → **9:16** output: crop width, full height, center on face/subject bbox (or frame center).
- Matching aspect ratios → `{ x: 0, y: 0, w: 1, h: 1 }`.

Used by `videoTransform.reframe` and `creativeMoments` with `spatialRef`.

## Style presets

`DEFAULT_RENDER_STYLE_PRESETS` in `style-presets.js` defines font, color, position for:

- `subtitles.default`, `subtitles.shorts`
- `overlays.hook_large`, `hook_question`, `hook_number`, `caption_bar`

Recipe `renderStylePresets` (v2.4+) overrides these at render time.

## FFmpeg mapping outline (future)

Per output:

1. `context = resolveRenderContext(workDir, recipe)`
2. `edl = buildRenderEdl(output, recipe, context)`
3. For each EDL segment:
   - `ffmpeg -ss <in> -to <out> -i <videoSourcePath>` (video stream)
   - Separate audio input when `audioSourcePath !== videoSourcePath`
   - Apply `computeReframeCrop()` when `output.format === "9:16"`
4. Apply `cuts[]` on audio (word timestamps from `context.wordIndexes`)
5. Concat segments respecting `outputStartSec` / J-cut overlap from timeline
6. Overlay `creativeMoments`, burn subtitles from word indexes + `renderStylePresets`
7. Mix `musicBed` per `audioMixPlan` (LUFS, ducking)
8. Export to `<outputId>_<format>.mp4`

## Verification

```bash
npm test -- src/render/
```

Fixtures: `fixtures/batches/mini-day/` (`golden-recipe-v2.json`, scene catalog, words, spatial index).
