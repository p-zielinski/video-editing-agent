# Plan naprawczy luk przed montażem

> Data: 2026-06-27  
> Status: **zamknięty (W1–W4.6)** — renderer FFmpeg wdrożony (W4.5/W4.6); `jump_cut` ma creative pulse (W4.11); deferred: `match_cut` / `whip_pan`, J/L-cut frame-accurate  
> Powiązane: [`FORMATY_AI_I_GOTOWOSC_MONTAZU.md`](./FORMATY_AI_I_GOTOWOSC_MONTAZU.md)

## Cel

Zamknąć luki z §6.3 dokumentu formatów tam, gdzie da się to zrobić **analizą, schematem i kodem pre-render** — bez pełnego renderera FFmpeg (osobna faza).

## Mapowanie luka → remediacja

| Luka | Możliwe przez analizę/tech? | Remediacja | Faza |
|------|----------------------------|------------|------|
| Brak modułu renderu | Częściowo — kontrakt + EDL + scaffold | `src/render/`, `RENDER_MODULE_SPEC.md` | W1 |
| Brak `sfxPlan[]` | **Tak** — `audioEvents` + PANNs już w pipeline | Schema v2.4 + `buildSfxPlanFromAudio()` | W1 |
| Brak color grade / LUT | **Tak** — schema + presety (egzekucja w rendererze) | `colorGrade` + `assets/luts/catalog.json` | W1 |
| Presety napisów/overlayów | **Tak** — schema + `renderStylePresets` | v2.4 + `src/render/style-presets.js` | W1 |
| `videoTransform.reframe` bez crop box | **Tak** — `computeReframeCrop()` ze spatial index | `src/render/reframe.js` | W1 |
| Tolerancja sync B-roll | **Tak** — keyframes + vision `keyMoments` | `broll-sync-hints.js` + brief directora | W2 |
| Keyframes ~6/min na B-roll | **Tak** — gęstszy sampling | `keyframes.js` +12/min dla `broll_pool` | W2 |
| `audioPolicy: external` bez ścieżki | **Tak** — `resolveTrackById` już jest | `resolve-render-context.js` + V23-02/03 | W1 |
| Stub vision w `--fast` | Ograniczenie dev — nie bug | Dokumentacja + `report` gates | W3 |
| `transition`/`bridge` segmentRole | Deferred — creativeMoments wystarczą | Bez zmian schematu v2.4 | — |
| Frame-accurate sync | Wymaga renderu + opcjonalnie optical flow | Faza renderu (poza scope) | W4 |

## Workstreamy wdrożenia

### W1 — Schema v2.4 + kontrakt renderu (priorytet 1)

- `EditRecipe` v2.4: `sfxPlan[]`, `colorGrade`, `renderStylePresets`
- Eksport JSON Schema + testy kontraktu
- `src/render/resolve-render-context.js` — clipId→path, trackId→file, words
- `src/render/build-render-edl.js` — EDL z `buildOutputTimeline` + segmentów
- `docs/RENDER_MODULE_SPEC.md`

### W2 — Analiza gęstsza + hinty sync (priorytet 2)

- Keyframes: `maxFramesPerMin: 12` dla klipów `broll_pool` / scen bez mowy
- `src/editorial/sfx-plan.js` — propozycja SFX z `audioEvents` / `editorialTags`
- `src/editorial/broll-sync-hints.js` — sugestie `videoInSec` z keyframes + L1 `keyMoments`
- Wpięcie hintów do `buildDirectorBrief()` (skrót w brief)

### W3 — Walidacja rozszerzona (priorytet 2)

- V23-02: `voiceTargetLufs` / `preWhisperNormalizeLufs` w zakresie [-24, -12]
- V23-03: `musicBed.trackId` istnieje i plik na dysku
- V24-01…04: `sfxPlan`, `colorGrade`, `renderStylePresets`
- Testy w `recipe-v2-validator.test.js`

### W4 — Renderer FFmpeg

- [x] `execute-render.js` + CLI `render`
- [x] Segmenty A-roll + B-roll cross-clip
- [x] 9:16 reframe, ASS, overlaye, creativeMoments, audioMixPlan
- [x] W4.5/W4.6 — concat crossfade (2-seg), `CROSSFADE_NOT_APPLIED` manifest, J/L carry-forward (`audio-jlcut.js`), audio mix + `duckingDb`, manifest `audioMixApplied`
- [x] `jump_cut` — creative pulse brightness/contrast (W4.11)
- [ ] J/L-cut frame-accurate, match_cut, whip_pan (best-effort / deferred)

## Kryteria done (pre-render)

- [x] `npm test` zielone po zmianach schematu
- [x] `schemas/json/EditRecipeV2.schema.json` zawiera v2.4 pola
- [x] `resolveRenderContext()` + testy jednostkowe
- [x] `buildSfxPlanFromAudio()` + testy
- [x] Keyframes broll density + test
- [x] Wpięcie `sfxPlanDefaults` i `brollSyncHints` do `buildDirectorBrief()`
- [x] `FORMATY_AI_I_GOTOWOSC_MONTAZU.md` zaktualizowany (§6.3 — co zamknięte)

## Weryfikacja końcowa

1. Agent explore: audyt diff vs plan
2. Agent: aktualizacja `FORMATY_AI_I_GOTOWOSC_MONTAZU.md`
3. `npm test` pełny
