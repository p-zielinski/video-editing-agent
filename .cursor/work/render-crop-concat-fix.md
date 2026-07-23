# Render crop 4K + concat duration fix

> Last updated: 2026-07-19
> Branch: `main`
> Status: done

## Problem & goal

1. **Main 16:9** padał na `crop=3840:2160` (iPhone rotation −90°, decoded 2160×3840).
2. **Short 9:16** miał ~145 s zamiast ~58 s przez `demuxer_concat -c copy` z mixed FPS.

## Scope

- **In scope:** `ffmpeg-reframe.js` (iw/ih crop, skip no-op), `ffmpeg-concat.js` + `boundary-compositor.js` (hard concat), CLI error message, testy, weryfikacja batch `51cd206d`.
- **Out of scope:** rotation-aware ingest (`probeVideoDimensions`), jakość montażu.

## Key files & context

| Area | Path | Role |
|------|------|------|
| Crop fix | `src/render/ffmpeg-reframe.js` | `formatCropFilter`, `isNoOpCrop` |
| Concat fix | `src/render/ffmpeg-concat.js` | `buildHardConcatFilterComplex` |
| Concat exec | `src/render/boundary-compositor.js` | `applyHardConcat`, strategy `hard_concat` |
| CLI DX | `src/cli.js` | `printRenderResults` — błąd zamiast `null` |
| Tests | `src/render/ffmpeg-reframe.test.js`, `ffmpeg-concat.test.js`, `boundary-compositor.test.js` | regresja |

## Decisions

- 2026-07-19: crop przez `iw`/`ih` zamiast absolutnych pikseli z katalogu (rotation-safe).
- 2026-07-19: skip no-op full-frame crop (`w>=0.99 && h>=0.99`) — subject reframe 16:9→16:9 idzie od razu na scale.
- 2026-07-19: `hard_concat` z `setpts=PTS-STARTPTS` zamiast demuxer `-c copy`.

## Progress

- [x] Crop fix + testy
- [x] Hard concat + testy
- [x] CLI `Render nieudany: …` zamiast `Wyrenderowano: null`
- [x] Re-render batch `51cd206d --force --render-profile production`

## Verification

```bash
node --test src/render/ffmpeg-reframe.test.js src/render/ffmpeg-concat.test.js src/render/boundary-compositor.test.js
# 57 pass

node src/cli.js render --batch-id 51cd206d --force --render-profile production
```

**Wynik batch `51cd206d` (2026-07-19):**

| Output | Plik | Duration |
|--------|------|----------|
| main 16:9 | `renders/output_0_16x9_16x9.mp4` | **293.0 s** |
| short 9:16 | `renders/output_1_9x16_9x16.mp4` | **58.0 s** (było 145.4 s) |

Manifest: `13-render-manifest.json` — oba outputy OK, `segmentErrors: []`.

## Next steps

- Follow-up: rotation-aware `probeVideoDimensions` w ingest (katalog aspect vs decoded frame).
- Obejrzeć main/short pod kątem jakości montażu (osobny temat).

## Blockers / open questions

- Brak
