# Render module specification

> Last updated: 2026-06-27  
> Status: **implemented** (FFmpeg executor)  
> Related: [`LUKI_PLAN_NAPRAWCZY.md`](./LUKI_PLAN_NAPRAWCZY.md) W4, [`EDITING_RECIPE_V2_SPEC.md`](./EDITING_RECIPE_V2_SPEC.md) §14

## Purpose

The render module executes **EditRecipe** → **MP4** using FFmpeg. It reads batch artifacts from `output/.work/<batchId>/` and writes outputs to `renders/`.

## CLI

```bash
node src/cli.js render --batch-id <id>
node src/cli.js render --batch-id <id> --output-id horizontal_main
node src/cli.js render --batch-id <id> --encode-profile draft   # szybki podgląd
node src/cli.js render --batch-id <id> --encode-profile production  # domyślny
node src/cli.js render --batch-id <id> --dry-run
node src/cli.js render --batch-id <id> --force
```

Wymaga: FFmpeg (+ libass dla napisów ASS).

## Module layout

| File | Role |
|------|------|
| `execute-render.js` | Orchestrator: recipe → MP4 per output, manifest |
| `render-config.js` | Profile `draft` / `production`, wymiary output |
| `resolve-render-context.js` | clipId → paths, word indexes, music bed, spatialIndex |
| `build-render-edl.js` | EDL z `buildOutputTimeline()` |
| `ffmpeg-segment.js` | Trim segmentu → temp MP4 |
| `ffmpeg-concat.js` | Concat segmentów |
| `ffmpeg-reframe.js` | Crop/scale 9:16 z `computeReframeCrop()` |
| `ffmpeg-creative.js` | `creativeMoments` (zoom, ken burns, …) |
| `ffmpeg-graphics.js` | `textOverlays` (drawtext) |
| `ass-subtitles.js` | Napisy ASS word-by-word |
| `audio-cuts.js` | `cuts[]` na word timestamps (video+audio splice) |
| `audio-jlcut.js` | J/L-cut (`acrossfade` gdy `overlapSec > 0`) |
| `audio-mix.js` | `audioMixPlan` + `sfxPlan` |
| `color-grade.js` | `colorGrade` eq + lut3d |
| `technique-to-ffmpeg.js` | Mapowanie `techniqueId` → filtry |
| `reframe.js` | Normalized crop box |
| `style-presets.js` | Domyślne style napisów/overlayów |

## Render pipeline (multi-pass)

1. `resolveRenderContext()` + `buildRenderEdl()` per output
2. **Segment pass** — każdy segment → `renders/.tmp/<outputId>/seg_NNN.mp4`
3. **Concat** — `concat.mp4` (chained `xfade`+`acrossfade` when eligible; otherwise plain concat)
4. **Creative** — `creativeMoments` (camera zoom, …); boundary `crossfade` omitted when already applied or ineligible
5. **Subtitles** — ASS burn-in gdy `subtitles.policy !== off`
6. **Graphics** — `textOverlays` (hook_large, emphasis, …)
7. **Audio mix** — music bed ducking + sfxPlan
8. **Color grade** — eq / LUT
9. Export → `renders/<outputId>_<format>.mp4`
10. Manifest → `13-render-manifest.json`

## Artefakty wyjściowe

```
output/.work/<batchId>/
  renders/
    horizontal_main_16x9.mp4
    short_9x16_9x16.mp4
  13-render-manifest.json
```

## Obsługiwane możliwości EditRecipe

| Obszar | Status |
|--------|--------|
| A-roll / B-roll cross-clip | ✅ |
| `from_video_ref` / `from_audio_ref` | ✅ |
| `syncMode` loop_video, fit_video_to_audio | ✅ częściowo |
| `cuts[]` word-level | ✅ (video+audio splice via trim/concat) |
| 9:16 reframe + spatial anchor | ✅ |
| ASS subtitles word_by_word | ✅ |
| textOverlays | ✅ drawtext |
| creativeMoments camera | ✅ scale/zoompan |
| creativeMoments graphics | ✅ `hook_visual_punch`, `retention_beat` (video); `hook_title_overlay` via textOverlays |
| audioMixPlan + music bed | ✅ gdy plik istnieje; loudnorm voice (`voiceTargetLufs`); ducking via `buildSidechainCompressFilter(duckingDb)` |
| sfxPlan library | ✅ gdy plik w `assets/sfx/` |
| colorGrade | ✅ eq + lut3d |
| J/L-cut overlap | ✅ `acrossfade` gdy `overlapSec > 0`; concat bez overlap |
| `crossfade` | ✅ chained `xfade`+`acrossfade` (2 segmenty; 3+ gdy **jeden** join z crossfade lub **wszystkie** joiny); brak J/L; inaczej `CROSSFADE_NOT_APPLIED` |
| `jump_cut` | ✅ minimal pulse brightness/contrast w creative pass (jak `hard_cut_energy`; nie prawdziwe cięcie na granicy segmentu) |
| `cut_on_beat` | ✅ beat snap na granicy segmentu w concat (±`snapToleranceSec`, `audioIndex` beats); `CUT_ON_BEAT_SNAPPED` w manifeście; brak beatów → `CUT_ON_BEAT_NOT_APPLIED` |
| `hard_cut_energy` | ✅ pulse brightness/contrast w creative pass (nie prawdziwe cięcie na granicy segmentu) |
| `zoom_punch_out` | ✅ scale/zoompan punch-out (factor &lt; 1, domyślnie 0.92) w creative pass |
| `dip_to_black` | ✅ minimal fade out/in (`fade=t=out` + `fade=t=in`, 0.3–0.8 s) w creative pass |
| `cut_mid_sentence` | ✅ silniejszy retention pulse w creative pass; `CUT_MID_SENTENCE_ACK` gdy moment na granicy segmentu (±0.1 s) |
| `match_cut` | ✅ best-effort: krótki kierunkowy motion blur + subtelny scale (0.15–0.25 s) w creative pass |
| `whip_pan` | ✅ kierunkowy gblur w creative pass |
| music_swell, music_drop | ✅ volume automation na music bed w `audio-mix.js` gdy `musicBed` |
| silence_beat | ✅ dip głosu w `audio-mix.js` (wymaga `audioMixPlan` aby uruchomić mix pass) |

### J/L-cut (`from_prev` / `from_next`)

**Segment pass (video-only for borrowed audio):** segmenty z `audioPolicy: "from_prev"` lub `"from_next"` renderują **tylko wideo** (`-an`, bez ścieżki audio w pliku segmentu). Audio sąsiada jest składane w pass concat (`audio-jlcut.js`): carry-forward z `[i-1:a]` przy J-cut lub early-pull z `[i+1:a]` przy L-cut, z `acrossfade` gdy `overlapSec > 0`.

**Carry-forward w concat:** `applyJlCutAudio` (`audio-jlcut.js`) skleja wideo zwykłym `concat` (bez overlap na wideo), a audio łączy `acrossfade` na granicach gdzie `overlapSec > 0`. `buildOutputTimeline()` przedłuża `outputEndSec` poprzedniego segmentu o `overlapSec`, żeby okno audio carry-forward było spójne z EDL (np. seg N-1 kończy się w `outputStartSec(seg N) + overlapSec`).

Gdy `overlapSec === 0`, concat używa zwykłego demuxera concat (bez acrossfade).

### Crossfade (concat)

Concat applies real video+audio crossfade when **all** of the following hold:

1. A `creativeMoments` entry with `techniqueId: "crossfade"` aligned to at least one join (`outputStartSec` ≈ `segments[i].outputStartSec`, ±0.1 s).
2. No J/L overlap (`overlapSec` / `from_prev` audio policy).
3. Eligible segment layout:
   - **2 segments** — crossfade at the single join, or
   - **3+ segments** — crossfade at **exactly one** internal join (xfade at that join + hard `concat` for remaining), **or** crossfade at **every** internal join (fully chained xfade).

Segment durations for offset math come from EDL (`outputEndSec - outputStartSec`). Chained offsets: first join `offset = dur(seg0) - durationSec`; each subsequent xfade uses cumulative duration minus prior crossfade overlaps.

When a boundary crossfade is requested but concat cannot apply it (e.g. partial crossfade on 4+ segments, or J/L overlap), `execute-render` emits manifest warning `CROSSFADE_NOT_APPLIED`. Reasons: `requires timeline without J/L overlap` or `requires crossfade at every internal join or exactly one join`. The moment is **not** passed to the creative pass. When concat **does** apply xfade, the crossfade moment is excluded from the creative pass.

Helpers: `buildMultiSegmentXfadeFilterComplex`, `computeXfadeOffsetAtBoundary`, `isTwoSegmentCrossfadeEligible`, `isMultiSegmentCrossfadeEligible`, `isCrossfadeEligible`, `shouldDeferCrossfadeToCreative`, `resolvePostConcatCreativeMoments` in `ffmpeg-concat.js`.

**Limitations:** crossfade at join 2 only on a 3-segment timeline (not join 1) is supported via xfade+concat chain but output duration may differ slightly from EDL when only one of two joins is soft. Partial patterns (e.g. 2 of 3 joins) are not supported.

### Cut on beat (concat snap)

When a `cut_on_beat` `creativeMoment` aligns with a segment join (±0.1 s, same as crossfade) and `05d-audio-index.json` provides beats for the outgoing clip (`beatTimes`, `beatTimestamps`, or `beats`), concat snaps the join to the nearest beat within `params.snapToleranceSec` (default **0.5 s** from `techniques/edit/cut_on_beat.json`).

- Snap **before** concat: trims end of outgoing segment or start of incoming segment via FFmpeg re-encode (`applyBeatSnapTrims`).
- Manifest warning `CUT_ON_BEAT_SNAPPED` with `originalJoinSec`, `snappedJoinSec`, `beatSourceSec`, `clipId`.
- No beat within tolerance or missing `audioIndex` → `CUT_ON_BEAT_NOT_APPLIED`; moment excluded from creative pass (no `TECHNIQUE_DEFERRED_CONCAT`).
- Skipped when J/L overlap is present (same as crossfade).

Helpers: `findCutOnBeatAtBoundary`, `computeBeatSnapAtBoundary`, `collectBeatSnapsAtBoundaries` in `ffmpeg-concat.js`. `resolveRenderContext` loads optional `audioIndex` from `05d-audio-index.json`.

### Cut mid-sentence (creative pulse)

When a `cut_mid_sentence` `creativeMoment` aligns with a segment join (±0.1 s), the creative pass applies a **stronger** brightness/contrast retention pulse than `jump_cut` (scaled by `params.energy`: low/medium/high). Manifest warning `CUT_MID_SENTENCE_ACK` records the boundary join. The actual cut is already in the EDL; this is a visual montage acknowledgment only.

Helper: `findCutMidSentenceAtBoundary` in `ffmpeg-concat.js`.

### Dip to black (creative fade)

`dip_to_black` renders a short fade-out to black and fade-in (`fade=t=out` + `fade=t=in`, duration clamped 0.3–0.8 s) centered at `outputStartSec`. Optional `holdBlackSec` (default 0.2 s). Implemented in `technique-to-ffmpeg.js` (`buildDipToBlackFilter`).

### Music bed ducking (`duckingDb`)

`audioMixPlan.musicBed.duckingDb` (negative dB, default **-12**) controls how much the bed is compressed under voice during the audio mix pass. `buildSidechainCompressFilter(duckingDb)` in `audio-mix.js` maps depth to FFmpeg `sidechaincompress` params:

| `duckingDb` | Approx. `ratio` | `threshold` |
|-------------|-----------------|---------------|
| -12 (default) | 6.0 | 0.050 |
| -18 | 9.0 | 0.033 |

Deeper ducking (more negative) → higher ratio and lower threshold. Skipped when `mixSegment.duckUnderVoice === false`.

Manifest per-output fields:

- `audioMixApplied: true` — mix pass ran FFmpeg (not passthrough copy)
- `sfxApplied: true` — at least one `sfxPlan` entry mixed (`library` or `audio_event`)
- `segmentWarnings[]` — segment-pass warnings only (e.g. `broll_av_desync`)
- `segmentErrors[]` — per-segment render failures (`segmentId`, `message`); output aborted, `outputPath` null

`sfxPlan` `source: "audio_event"` uses `context.clips[clipId].sourcePath` + `anchorTimeSec` (`atrim`/`adelay`). Unresolved SFX → `warnings` with `SFX_UNRESOLVED`.

## Encode profiles

| Profile | Video | Audio |
|---------|-------|-------|
| `production` (domyślny) | libx264 slow CRF 18 | AAC 192k |
| `draft` | libx264 ultrafast CRF 23 | AAC 128k |

## Verification

```bash
npm test -- src/render/
npm run test:e2e   # tests/e2e/render-mvp.test.js, render-shorts.test.js
```
