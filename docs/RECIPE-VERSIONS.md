# EditRecipe — wersje 2.x

Schemat: `src/schemas/edit-recipe-v2.js`, JSON Schema: `schemas/json/EditRecipeV2.schema.json`.

Produkcja (segment director, nowe szkice): domyślnie **`version: "2.4"`**. Starsze wersje pozostają ważne — brak pola opcjonalnego nie wymusza bumpu wersji.

---

## Tabela wersji

| Wersja | Co dodaje | Pola / zachowanie |
|--------|-----------|-------------------|
| **2.0** | Bazowy montaż multi-clip v2 | `outputs[]` z `timeline[]`: `segmentRole`, `videoRef` / `audioRef`, `audioPolicy`, `cuts[]`, `videoTransform`; `clipRegistry`, `excluded`, `sceneUsageRegistry`, `batchContext` |
| **2.1** | Warstwa kreatywności | `creativityProfile`, `creativeMoments[]` (techniki z `techniques/`), budżety gęstości; walidacja V21-* |
| **2.2** | Gramatyka retencji | `shortsRetentionProfile`, `vlogRetentionProfile`, `retentionBeatTargets`, `textOverlays` (`style`, `role`), `retentionRole` na momentach; walidacja V22-* / V22-VLOG-* |
| **2.3** | Plan miksowania audio (pre-render) | `audioMixPlan`: `voiceTargetLufs`, `preWhisperNormalizeLufs`, `musicBed`, `segments[]`, `duckingWindows[]`; walidacja V23-* |
| **2.4** | SFX, kolor, presety renderu | `sfxPlan[]`, `colorGrade`, `renderStylePresets`; walidacja V24-*; domyślna wersja wyjściowa directora |

Pola współdzielone między wersjami (nie wymuszają bumpu samodzielnie): `narrativeProfile`, `structuredCallbacks`, `pacingTrimMeta`, `needsHumanReview`.

---

## Kody walidacji ≠ wersja receptury

Prefiks **V25-** i wyższe to **kody walidatora**, nie nowa wersja schematu `version`:

| Prefiks | Zakres |
|---------|--------|
| V25-* | Aspect ratio, B-roll strategy/sync, chronologia multi-clip, voice-over cross-clip |
| V26-* | Modulacja głosu (`voice_pitch_shift`) |
| V27-* | Render fidelity (`renderSupport` technik vs FFmpeg) |
| NAR-* | Narracja / open loops vs retencja |

Receptura może mieć `version: "2.4"` i jednocześnie podlegać regułom V25-VLOG, V27-RENDER itd.

---

## Powiązane

- [`docs/PIPELINE.md`](PIPELINE.md) — krok `direct`, enrichery, review
- [`prompts/v2/director.md`](../prompts/v2/director.md) — kontrakt pól per wersja w prompcie
- [`prompts/v2/critic.md`](../prompts/v2/critic.md), [`prompts/v2/fixer.md`](../prompts/v2/fixer.md) — kody napraw
