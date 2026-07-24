# Render quality fixes (51cd206d)

> Last updated: 2026-07-24
> Branch: (local worktree)
> Status: done

## Problem & goal

Fix five quality issues in batch `51cd206d` renders (cold open CTA, denoise blocked by preserveAmbient, JL-cut A/V desync, yellow salvage overlay, aggressive 9:16 crop).

## Scope

- **In scope:** A1–A5 code fixes, recipe salvage, production re-render + spot-check
- **Out of scope:** dynamic face tracking, Whisper re-transcribe, blur letterbox polish, LLM cold-open redesign

## Key files & context

| Area | Path | Role |
|------|------|------|
| Reframe | `src/render/ffmpeg-reframe.js` | subjectTooWide → pad without fitMode=fill |
| Ambient | `src/editorial/intentional-ambient.js` | clear false preserveAmbientAudio |
| JL-cut | `src/render/audio-jlcut.js` | from_prev carryDur = overlapSec |
| Cold open | `src/editorial/chapter-hints.js` | tease window avoids CTA tail |
| Graphics | `src/render/ffmpeg-graphics.js` | fitOverlayText wrap/shrink |
| Recipe | `output/.work/51cd206d/09-edit-recipe-final.json` | salvaged batch |
| Renders | `output/.work/51cd206d/renders/*.mp4` | production outputs |

## Decisions

- 2026-07-24: Cold open window moved to clip40 **132→140** (not last 8s / 152→160 CTA).
- 2026-07-24: Removed yellow `callback_payoff_clip40_caption` emphasis from cold open entirely.
- 2026-07-24: Explicit `preserveAmbientAudio: false` on speech A-roll; shorts use `fitMode: pillarbox`.
- 2026-07-24: Second `--force` production render after overlay removal (first render still had yellow baked in).

## Progress

- [x] A5 reframe subjectTooWide → pillarbox + tests
- [x] A3 preserveAmbient sanitize + tests
- [x] A2 JL carryDur = overlapSec + tests
- [x] A1 cold open CTA avoidance + tests
- [x] A4 overlay wrap/shrink + tests
- [x] B recipe salvage
- [x] C force re-render + verify symptoms

## Next steps

1. Optional: re-transcribe poisoned Whisper clip17/40.
2. Optional: blur letterbox for 16:9→9:16.

## Blockers / open questions

- None blocking; Whisper poison is a follow-up.

## Verification

```bash
node --test …  # 56 pass (reframe, ambient, jlcut, graphics, cold-open)
node src/cli.js render --batch-id 51cd206d --render-profile production --force
# main 211.8s, short 23.1s — exit 0
# yellow_frac first 2.5s = 0; short letterbox pad; cold 132–140; no preserveAmbient true
```
