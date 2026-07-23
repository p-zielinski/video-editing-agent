# hook_visual_punch zoompan fix

> Last updated: 2026-07-20
> Status: done (fix + batch rerun complete)

## Problem & goal

FFmpeg 8.1.2 rejects `zoompan` `z=` expressions containing `if(between(...))` with commas, causing `CREATIVE_FALLBACK` for `hook_visual_punch` (and other techniques using timed zoompan).

**Done:** Replace timed zoompan with `scale` + `crop` (same pattern as `buildSlowPushFilter`).

## Follow-on fixes during batch rerun

- `NarrativeIntentSchema` coerce: `callback`→`reveal`, `flashback`→`memory`
- `sanitizeDuplicateSameFormatOutputs` (drop duplicate `output_0_16x9` vs `main_16x9`)
- `sanitizeCreativityLevelGate` (drop `match_cut` at balanced)
- Vlog beat sanitize improvements

## Progress

- [x] Rewrite `buildScalePunchFilter` + ken_burns + reframe
- [x] Tests + FFmpeg smoke
- [x] Reviewer APPROVED
- [x] Batch `51cd206d` abstract→review→render (production)
- [x] No `CREATIVE_FALLBACK` on creative moments pass

## Verification

```bash
node --test src/render/technique-to-ffmpeg.test.js
# 36 pass

# Renders (2026-07-20):
# output/.work/51cd206d/renders/main_16x9_16x9.mp4
# output/.work/51cd206d/renders/output_1_9x16_9x16.mp4
```
