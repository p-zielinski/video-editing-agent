# Batch 51cd206d recovery → render

> Last updated: 2026-07-24
> Branch: (local work)
> Status: done

## Problem & goal

Finish batch `51cd206d` through production render after cascade of failures
starting at `audio_enhancement` (missing SD source for clip28).

## Scope

- **In scope:** recover audio, Zod/validator fixes, recipe salvage, render bugfix, production renders
- **Out of scope:** quality-gate topic_match_rate / human-review polish

## Key files & context

| Area | Path | Role |
|------|------|------|
| Main render | `output/.work/51cd206d/renders/main_16x9_16x9.mp4` | **212.6 s, 545 MB** |
| Short render | `output/.work/51cd206d/renders/short_9x16_9x16.mp4` | **23.1 s, 95 MB** |
| Final recipe | `09-edit-recipe-final.json` | salvaged + validated |
| Reframe aliases | `src/schemas/edit-recipe-v2.js` | `center_crop`→`center`, `follow_subject`→`subject` |
| AUD-QUAL ambient | `src/validators/recipe-v2.js` | skip preserveAmbient-only accepts |
| Word-cut split | `src/render/audio-cuts.js`, `time-cuts.js` | `split=N` before multi-trim |

## Decisions

- 2026-07-24: clip28 fail = SD unmounted at extract; remounted + dpdfnet OK.
- 2026-07-24: Fixer aliases coerced via Zod preprocess (NarrativeIntent pattern).
- 2026-07-24: Escalation fixer dropped 9:16 — restored from `fixer__…attempt-1.json`, deterministic salvage (drop illegal chapter_card on main, add clip40 payoff overlay).
- 2026-07-24: 4K dead_air cuts: multi-`trim` on same `[vcutin]` pad → FFmpeg concat size bug; fixed with `split=N`.

## Progress

- [x] Fix clip28 audio_enhancement
- [x] ReframeModeSchema + AUD-QUAL preserveAmbient exemption + tests
- [x] Salvage valid final recipe (16:9 + 9:16)
- [x] thumbnails + publish
- [x] Fix word-cut split bug + tests
- [x] Production render main + short

## Next steps

1. Optional: watch both MP4s for editorial quality
2. Optional: address quality gate `topic_match_rate_below_50` / `needsHumanReview`

## Blockers / open questions

- None for pipeline completion. Keep SD mounted if re-rendering from sources.

## Verification

```bash
ffprobe …/renders/main_16x9_16x9.mp4   # duration≈212.6s
ffprobe …/renders/short_9x16_9x16.mp4  # duration≈23.1s
node --test src/schemas/edit-recipe-v2-reframe.test.js \
  src/render/audio-cuts.test.js src/render/time-cuts.test.js
```
