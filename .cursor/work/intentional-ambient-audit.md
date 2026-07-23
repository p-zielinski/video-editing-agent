# Intentional ambient / background sound audit

> Last updated: 2026-07-23  
> Branch: `main` (local)  
> Status: done (implemented)

## Problem & goal

Creator says something, then stops: *“posłuchajcie jak tu pięknie słychać śpiew ptaków”* — bird song (ambient on the VO clip) must stay audible: not destroyed by DPDFNet denoise, not incorrectly ducked/masked in mix.

**Done looks like:** Director (or enricher) can mark an ambient showcase window; enhancement skips denoise for that clip/window; render uses source audio when rejected; music bed gets out of the way during the showcase; birds/nature survive to playback.

## Verdict

**Implemented (2026-07-23)** — Phase A render gate + Phase B `preserveAmbientAudio` enricher + Phase C mix/silence soft-disable. DPDFNet still runs only for explicit `accept`; reject / preserve paths use original VO audio.

---

## Implementation summary (2026-07-23)

| Area | Change |
|------|--------|
| Render | `buildEnhancedAudioPaths(workDir, index, recipe)` — if decisions exist, only `action === "accept"`; empty/absent decisions → legacy index succeeded |
| EDL | `resolveAudioSourcePath` never uses enhanced WAV when `segment.preserveAmbientAudio` |
| EDL mapping | `mapSegmentToEdl` copies `preserveAmbientAudio` onto EDL segments (fix 2026-07-23: was dropped before enrich) |
| Schema | `TimelineSegmentV2.preserveAmbientAudio?`, `CreativeMoment.disabled?` |
| Enricher | `enrichIntentionalAmbient` (after color-grade, before sanitize): keyword detect → flag → reject auto-accept → soft-disable `silence_beat` → music duck 0 on showcase |
| Enhancement | `clipOnlyUsedOnPreserveAmbient` skips accept; reconcile no longer flips non–artifact-missing rejects |
| Mix | `resolveVoiceAudioMoments` / music-bed ignore `disabled` moments |

### Key files

| Path | Role |
|------|------|
| `src/editorial/intentional-ambient.js` | Detect + mark + reject + duck + silence soft-disable |
| `src/render/resolve-render-context.js` | Decision-gated `buildEnhancedAudioPaths` |
| `src/render/enrich-render-edl.js` | Per-segment preserve → original audio |
| `src/pipeline/steps/audio-enhancement.js` | Reconcile + preserve-only skip |
| `src/pipeline/steps/agents.js` | Wire `enrichIntentionalAmbient` |

### Tests

```bash
node --test \
  src/editorial/intentional-ambient.test.js \
  src/render/resolve-render-context.test.js \
  src/render/build-render-edl.test.js \
  src/render/enrich-render-edl.test.js \
  src/pipeline/steps/audio-enhancement.test.js \
  src/pipeline/steps/agents-enricher-order.test.js \
  tests/editorial/speech-ducking.test.js
```

---

## 1. DPDFNet / `audio_enhancement` path

### When is denoise applied?

| Trigger | Behavior |
|---------|----------|
| Director `audioEnhancementDecisions[].action === "accept"` | `runAudioEnhancementStep` runs `enhanceClipAudio` → `runEnhancementProvider` (default **DPDFNet**) |
| Director `reject` | Clip skipped in enhancement step |
| `enrichAudioEnhancementSpeechAccepts` (post-direct enrich) | Auto-adds **`accept`** for speech A-roll clip IDs **without** an existing decision; skips `preserveAmbientAudio` clips; never overwrites existing `reject` |
| `enrichIntentionalAmbient` | Sets `preserveAmbientAudio`; adds/flips reject `intentional_ambient_preserve` (no decision or auto-accept only) |
| `reconcileAudioEnhancementDecisions` | Adds accept for missing decisions when artifact exists; **only** flips reject when reason matches artifact-missing pattern — does **not** flip `intentional_ambient_preserve` |

**Director prompt** (`prompts/v2/director.md`): still no explicit ambient guidance (optional follow-up). Enricher covers transcript cue path.

### Does denoise remove wind/birds/nature?

**Yes on accept.** Flow unchanged for accepted clips. Preserve/reject path skips provider.

### “Preserve ambient” / reject-for-nature?

| Mechanism | Exists? |
|-----------|---------|
| `preserveAmbientAudio` on segment | **Yes** |
| Skip DPDFNet for nature | **Yes** (reject decision + preserve-only skip) |
| Render honors reject | **Yes** (`buildEnhancedAudioPaths` + per-segment gate) |
| `sourceVolumeDb` on preserve segments | Skipped in `materializeSourceVolumeDb` |

---

## 2. Music ducking / speech-aware mix

Speech/gap ducking unchanged (`SPEECH_DUCK_DB` / `GAP_DUCK_DB`). Ambient showcase windows get `duckingDb: 0` via `mergeAmbientShowcaseDucking` without wiping speech ducks elsewhere. `silence_beat` overlapping preserve ranges is soft-disabled (`disabled: true`).

---

## Gaps ranked (post-fix)

| Rank | Gap | Status |
|------|-----|--------|
| **P0** | DPDFNet on intentional ambient | Fixed via enricher reject + skip |
| **P0** | Render ignores reject | Fixed |
| **P1** | Reconcile flips reject | Fixed (artifact-missing only) |
| **P1** | Blind speech auto-accept | Mitigated (ambient flips; skips preserve clips) |
| **P2** | No preserve schema signal | Fixed |
| **P2** | `silence_beat` on showcase | Soft-disabled |
| **P3** | Music at GAP_DUCK after speech | Showcase unduck to 0 |
| **P3** | Director prompt ambient rule | Still optional |

---

## What NOT changed

- DPDFNet provider / `DPDFNET_ATTN_LIMIT_DB`
- `shouldSkipPolishForWind` / `repair_only`
- Default `GAP_DUCK_DB` (-4)
- `silencePolicy: preserve` / dramatic_pause cut logic
- Sidechain ducking architecture
- SFX `bird` overlays

## Next steps

1. Optional: director prompt rule for ambient listen cues
2. Re-render `51cd206d` outdoor listen segment and A/B source vs previous enhanced
