# Audyt flow montażu AI — 2026-06-29

> Kontynuacja rozmowy o pionie/poziomie + pełny przegląd pipeline pre-render i render.

## Zaimplementowano w tej sesji

| Zmiana | Wpływ |
|--------|--------|
| **L3 → requiredFormats** (`resolve-required-formats.js`, orchestrator) | Summarizer może zasugerować tylko `9:16` lub `16:9` gdy user nie podał `--min-outputs` |
| **formatFit w L3** | Score 0–1 per format — director widzi w `sessionSummary` |
| **V25-AR aspect validator** | Ostrzeżenie gdy pion w main 16:9 bez `videoTransform` |
| **V25-BROLL-01** | Desync B-roll video/audio wykrywany przed renderem |
| **V24-07 SFX catalog** | Ostrzeżenie gdy library SFX nie mapuje się na katalog (sfxId lub tag) |
| **SFX timeline remap** | `sfxPlan` zsynchronizowany z osią outputu po cięciach |
| **Director brief** | `aspectMix`, `clipAspectById`, `sfxCatalogSummary` (dynamiczny katalog) |
| **Schema** | `requiredFormats` min 1 (single-format deliverable) |

### Użycie

```bash
# Domyślnie: L3 decyduje o formatach (jeśli nie --min-outputs)
node src/cli.js run --input ./inbox

# Jawny override
node src/cli.js run --input ./inbox --min-outputs 9:16
```

## Nadal do zrobienia (priorytet)

### P0 — jakość montażu

1. **Cold-open enrich** — `enrichRecipeColdOpenSegment()` z `coldOpenSegmentHint` (dziś tylko brief)
2. **B-roll sync apply** — `enrichBrollSyncFromHints()` deterministycznie ustawia `videoInSec`
3. **spatialRef na retention beatach** — `resolveSpatialRefForBeat()` często undefined bez face anchors

### P1 — opcje wykonania

4. **Render pass toggles** — `--skip-creative`, `--skip-subtitles`, `--skip-audio-mix`, resume z intermediate
5. **Crossfade + J/L** — video xfade gdy audio na J/L carry-forward
6. **Dead-air → silence_beat enrich** — deterministyczne `creativeMoments` z `deadAirMontageHints`
7. **Per-output colorGrade** — różny LUT/kontrast dla main vs short

### P2 — render / assety

8. **9:16 → 16:9 smart crop** — dziś pillarbox; opcjonalny `fitMode: crop` w `videoTransform`
9. **Production LUT** — `warm_golden_hour.cube` to stub 2×2
10. **match_cut vision** — obecnie pulse blur, nie vision-matched cut

## Metryki sukcesu

- Mniej `broll_av_desync` / `SFX_UNRESOLVED` w manifeście renderu
- Short-only batche bez wymuszonego słabego 16:9
- Critic łapie aspect mismatch przed fixerem (V25-AR)
- SFX trafiają w momenty po agresywnych cięciach (remap)

## Powiązane

- [`FORMATY_AI_I_GOTOWOSC_MONTAZU.md`](./FORMATY_AI_I_GOTOWOSC_MONTAZU.md)
- [`RETENTION_ENGAGEMENT_AUDIT_2026-06-28.md`](./RETENTION_ENGAGEMENT_AUDIT_2026-06-28.md)
- [`LUKI_PLAN_NAPRAWCZY.md`](./LUKI_PLAN_NAPRAWCZY.md)
- Handoff: `~/.cursor/work/format-aspect-pipeline.md`
