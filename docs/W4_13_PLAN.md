# W4.13 — Renderer polish + montage enrichment

> Last updated: 2026-06-28
> Status: **done** (W4.13-9 audit in `docs/EDITOR_AUDIT_2026-06-28.md`)

## Progress notes

- W4.13-3 (2026-06-28): `realignEdlAfterBeatSnaps` in `src/render/realign-edl-beat-snaps.js` — shifts segment/creative/overlay output times after beat-snap trims; `CUT_ON_BEAT_ALREADY_ALIGNED` vs `CUT_ON_BEAT_NOT_APPLIED`; E2E in `render-mvp.test.js`.
- W4.13-4 (2026-06-28): Chained xfade for 3+ segments in `ffmpeg-concat.js` — single-boundary (xfade + concat) and all-boundaries (full chain). Partial multi-boundary patterns still emit `CROSSFADE_NOT_APPLIED`.

Close remaining autonomous gaps from W4.12 audit and add easy montage wins without user-provided assets.

## In scope

| ID | Task | Owner | Priority |
|----|------|-------|----------|
| W4.13-1 | `zoom_punch_out` in `technique-to-ffmpeg.js` + tests | subagent | P1 |
| W4.13-2 | `dip_to_black` minimal fade filter (remove UNSUPPORTED) | subagent | P1 |
| W4.13-3 | `cut_on_beat` EDL realign after snap + E2E | subagent | P1 | ✅ done |
| W4.13-4 | `crossfade` chain for 3+ segments | subagent | P1 | ✅ done |
| W4.13-5 | `cut_mid_sentence` — boundary pulse + manifest ack | subagent | P2 |
| W4.13-6 | Prompt honesty: `jump_cut`/`hard_cut_energy` = retention pulse | subagent | P2 | ✅ |
| W4.13-7 | `safeZone` clamp for drawtext overlays | subagent | P2 | ✅ |
| W4.13-8 | Summarizer VO field tests | subagent | P2 | ✅ |
| W4.13-9 | Full editor audit → `docs/EDITOR_AUDIT_2026-06-28.md` | subagent | P1 |

## Out of scope

- SFX CC0 production downloads (subjective curation)
- `match_cut`, `whip_pan` full implementation
- Frame-accurate J/L-cut on video

## Progress

- [x] W4.13-1 `zoom_punch_out` in `technique-to-ffmpeg.js` + tests
- [x] W4.13-2 `dip_to_black` minimal fade filter (remove UNSUPPORTED)
- [x] W4.13-3 `cut_on_beat` EDL realign after snap + E2E
- [x] W4.13-4 `crossfade` chain for 3+ segments
- [x] W4.13-5 `cut_mid_sentence` — boundary pulse + manifest ack
- [x] W4.13-6 Prompt honesty: `jump_cut`/`hard_cut_energy` = retention pulse
- [x] W4.13-7 `safeZone` clamp for drawtext overlays
- [~] W4.13-8 Summarizer VO field tests (schema + L3 clipHints; brak testów pól VO w L1/L3 output)
- [ ] W4.13-9 Full editor audit → `docs/EDITOR_AUDIT_2026-06-28.md`

## Verification

```bash
npm test
npm run test:e2e
node --test src/render/technique-to-ffmpeg.test.js src/render/ffmpeg-creative.test.js
```

---

## Verification report (2026-06-28)

Automated check of W4.13 scope against code, tests, and docs. Targeted unit tests run:

```bash
node --test src/render/ffmpeg-concat.test.js src/render/realign-edl-beat-snaps.test.js \
  src/render/technique-to-ffmpeg.test.js src/render/ffmpeg-graphics.test.js
```

**Result: 58/58 passed** (ffmpeg-concat 28, technique-to-ffmpeg 21, realign-edl-beat-snaps 5, ffmpeg-graphics 4).

### Per-item matrix

| ID | Implemented? | Tests adequate? | Doc synced? | Notes |
|----|--------------|-----------------|-------------|-------|
| W4.13-1 `zoom_punch_out` | **Y** | **Y** | **Y** | `technique-to-ffmpeg.js` case + scale filter tests; listed in `listSupportedTechniques()`. `RENDER_MODULE_SPEC.md` row present. |
| W4.13-2 `dip_to_black` | **Y** | **Y** | **Partial** | `buildDipToBlackFilter`: chained `fade=t=out` + `fade=t=in`, duration 0.3–0.8 s. Removed from `UNSUPPORTED_TECHNIQUES` in `ffmpeg-creative.js` (only `match_cut`, `whip_pan` remain). `ffmpeg-creative.test.js` asserts not unsupported. **`FORMATY_AI_I_GOTOWOSC_MONTAZU.md` §6.3/§6.5 still lists `dip_to_black` as deferred** — stale. |
| W4.13-3 `cut_on_beat` realign + E2E | **Y** | **Y** | **Y** | `realignEdlAfterBeatSnaps` wired in `execute-render.js` after concat; unit tests + `render-mvp.test.js` E2E (duration + `CUT_ON_BEAT_SNAPPED`). `RENDER_MODULE_SPEC.md` §Cut on beat updated. |
| W4.13-4 crossfade 3+ chain | **Y** | **Y** | **Y** | `buildMultiSegmentXfadeFilterComplex`, eligibility (`1` or `all` boundaries), `CROSSFADE_NOT_APPLIED` for partial patterns. **`FORMATY_AI_I_GOTOWOSC_MONTAZU.md` still says crossfade 3+ deferred** — stale. |
| W4.13-5 `cut_mid_sentence` | **Y** | **Y** | **Y** | Stronger pulse in `buildCutMidSentencePulse`; `CUT_MID_SENTENCE_ACK` in `ffmpeg-creative.js`; boundary detection via `findCutMidSentenceAtBoundary`. Tests in `technique-to-ffmpeg.test.js` + `ffmpeg-creative.test.js`. **`FORMATY_AI_I_GOTOWOSC_MONTAZU.md` still lists as deferred** — stale. |
| W4.13-6 prompt honesty | **Y** | **N** | **Partial** | `prompts/v2/director.md` (retention pulse table) + `prompts/v2/critic.md` (renderer honesty). No automated prompt contract tests (expected). `RENDER_MODULE_SPEC.md` documents `jump_cut` / `hard_cut_energy` as pulse. |
| W4.13-7 `safeZone` clamp | **Y** | **Y** | **Y** | `clampOverlayPosition` in `ffmpeg-graphics.js` wraps `max`/`min` in **single-quoted** FFmpeg expressions; 9:16 margins from `style-presets.js` `formats["9:16"].safeZone`. |
| W4.13-8 Summarizer VO fields | **Partial** | **N** | **Partial** | `isNarrationSource` (L1) + `hasSeparateNarration` (L3) in `summarizer.js` outputSchema + `prompts/v2/summarizer.md` + `AbstractionBundle.schema.json`. `enrichSceneInputWithClipMeta` tested in `abstraction-chunking.test.js`; `clipHints` to L3 tested in `summarizer.test.js`. **Missing:** tests that L1/L3 mocked responses parse `isNarrationSource` / `hasSeparateNarration` through `AbstractL1Schema` / bundle. |
| W4.13-9 editor audit | **N** | **N** | **N** | `docs/EDITOR_AUDIT_2026-06-28.md` **does not exist**. |

### Deep-dive: `realignEdlAfterBeatSnaps`

**Verdict: correct for intended model; minor integration caveats.**

- **Segment shifts:** For each snap (sorted by `boundaryIndex`), shortens `segBefore.outputEndSec` and shifts `outputStartSec`/`outputEndSec` for segments at and after the boundary. Cumulative multi-boundary behavior matches tests (e.g. −0.2 + −0.3 → total −0.5 on tail).
- **Creative moments & overlays:** `shiftSecAtOutputTime` applies cumulative `deltaSec` for times ≥ `originalJoinSec` (epsilon 1 ms). Tests cover `creativeMoments` and `textOverlays`.
- **Integration:** Called in `execute-render.js` only when `appliedBeatSnaps.length > 0`. `outputMoments` shares object references with `edl.creativeMoments`, so in-place realign updates moments used by creative/audio passes. `cut_on_beat` moments are stripped before creative pass anyway.
- **Edge cases:**
  - J/L overlap: beat snaps skipped in concat (`collectBeatSnapsAtBoundaries` returns empty) — realign never runs; documented.
  - Positive `deltaSec` (trim incoming start): segment loop handles it; no dedicated unit test for positive delta.
  - Events spanning a join: start/end shifts differ (duration may change) — consistent with shortened timeline.
  - `edl.durationSec` recomputed from segments only (not audio-only tail) — acceptable for current EDL model.

### Deep-dive: multi-segment crossfade filter math

**Verdict: correct; matches FFmpeg xfade offset semantics.**

Chained builder (`buildMultiSegmentXfadeFilterComplex`) maintains running duration `curDur`:

- **xfade boundary:** `offset = max(0, curDur - d)`; then `curDur += nextSegDur - d`.
- **hard concat:** `curDur += nextSegDur`.

Verified examples (unit tests):

| Layout | Boundary | Expected offset | Test |
|--------|----------|-----------------|------|
| 30+30+30, xfade 0.3 at join 0 only | 0 | 29.7 | `ffmpeg-concat.test.js` |
| 10+10+10, xfade 0.5 at both joins | 0 / 1 | 9.5 / 19 | `computeXfadeOffsetAtBoundary` + filter string |

`computeXfadeOffsetAtBoundary` duplicates the running-duration logic for diagnostics; values align with inline builder.

**Limitation (documented in `RENDER_MODULE_SPEC.md`):** single crossfade on join 2 of 3 (not join 1) is supported via xfade+concat chain; output duration may diverge slightly from pre-concat EDL when only one of two internal joins is soft.

### Deep-dive: `dip_to_black` filter validity

**Verdict: valid FFmpeg filter chain.**

Example output shape:

```text
[0:v]fade=t=out:st=10:d=0.2:color=black,fade=t=in:st=10.4:d=0.2:color=black[vout]
```

- Sequential `fade` filters on one stream (comma-separated) is standard.
- `color=black` supported on fade filter.
- Duration clamped 0.3–0.8 s; `holdBlackSec` capped at half duration; minimum fade leg 0.05 s.
- Not in `listSupportedTechniques()` (transition, not camera) — intentional; still rendered via `buildTechniqueFilter` switch.

### Deep-dive: `safeZone` FFmpeg expression syntax

**Verdict: correct quoting for drawtext option parsing.**

`clampOverlayPosition` emits:

```text
x='max(48,min(w-text_w-48,(w-text_w)/2))'
y='max(120,min(h-text_h-200,h-text_h-192))'
```

Single quotes nest `max`/`min` so FFmpeg does not split on `:` or `,` inside drawtext options (comment in source documents this). Test `clamps drawtext position inside 9:16 safeZone margins` asserts margin literals 48/120/200.

### Doc sync gaps (actionable)

| Doc | Issue |
|-----|-------|
| `FORMATY_AI_I_GOTOWOSC_MONTAZU.md` §6.3 L368 | Still lists `dip_to_black`, `crossfade` (3+ seg), `cut_mid_sentence` as deferred |
| `FORMATY_AI_I_GOTOWOSC_MONTAZU.md` §6.5 L455 | W4 deferred row repeats same stale items |
| `W4_13_PLAN.md` | Progress table vs checkboxes were out of sync before this report (fixed above) |
| `W4_13_PLAN.md` status | W4.13-9 open; W4.13-8 partial |

### Recommended follow-ups

1. Create `docs/EDITOR_AUDIT_2026-06-28.md` (W4.13-9).
2. Add `summarizer.test.js` cases: L1 with `narration_track` clipRegistry asserts `isNarrationSource` in schema payload; L3 asserts `hasSeparateNarration` in bundle when clipHints include narration.
3. Refresh `FORMATY_AI_I_GOTOWOSC_MONTAZU.md` deferred table (move W4.13 items to ✅).
4. Optional: unit test `realignEdlAfterBeatSnaps` with positive `deltaSec`; integration test that post-snap creative moment times match realigned EDL.
