# Thumbnail framing + text fix

> Last updated: 2026-07-20
> Branch: `main`
> Status: done (code); regenerate thumbs when batch has final recipe

## Problem & goal

Batch `51cd206d` thumbnails were broken:

1. **Text / red bar** — one word per line; accent bar ~1 line tall → spill.
2. **16:9 framing** — face-only cover crop from portrait sources → extreme face zoom, dog lost.
3. **Detections unused** — shortlist/compose ignored dog/subject; wrong scene.resolution (3840×2160 vs decode 2160×3840).
4. **Sharp bug** — chaining `.composite()` after blur-pad dropped the sharp foreground (only blur remained under text).

**Done =** ≤2-line text inside bar; portrait→16:9 blur-pad keeps context (dog visible); detections wired; tests green.

## Scope

- **In scope:** compose, frame-score, thumbnails step, tests
- **Out of scope:** AI face polish (follow-up); rotation-aware timeline resolution

## Key files & context

| Area | Path | Role |
|------|------|------|
| Compose | `src/editorial/thumbnail-compose.js` | wrap, blur_pad, bbox normalize |
| Score | `src/editorial/thumbnail-frame-score.js` | dog boost, face-fill penalty, detections |
| Step | `src/pipeline/steps/thumbnails.js` | load detections, subject bbox at render |

## Decisions

- 2026-07-20: Portrait→16:9 → **blur_pad** (contain + blurred cover sides), not face cover-crop.
- 2026-07-20: Subject bbox from per-timestamp face/object detections; sceneId-scoped; orientation swap heuristic.
- 2026-07-20: Materialize blur_pad to PNG buffer before text SVG composite (Sharp multi-composite bug).
- 2026-07-20: AI enhance deferred — framing/text were the hard bugs.

## Progress

- [x] Root-cause investigation
- [x] Text wrap ≤2 lines + bar sizing
- [x] Subject-aware framing + blur-pad
- [x] Shortlist: multi-subject + detection timestamps + format-aware score
- [x] Wire detections into thumbnails step
- [x] Tests (16 pass)
- [x] Manual recompose on `old_51cd206d` frames (current `51cd206d` mid-pipeline)

## Next steps

1. When `51cd206d` has `09-edit-recipe-final.json`:  
   `node src/cli.js run --batch-id 51cd206d --from-step thumbnails --to-step thumbnails --force`
2. Optional: AI polish (`gpt-image` / face fix) behind env flag.
3. Optional: rotation-aware `scene.resolution` in timeline ingest.

## Blockers / open questions

- Active work dir `output/.work/51cd206d` was reset mid-run (only draft recipe); verified thumbs under `output/.work/old_51cd206d/thumbnails/`.
- TL `03b-twelvelabs-clip28.json` has empty moments — useful signal is object/face detections.

## Verification

```bash
node --test src/editorial/thumbnail-compose.test.js src/editorial/thumbnail-frame-score.test.js src/pipeline/steps/thumbnails.test.js
# 16 pass

# Visual check (dog + text in 16:9 blur-pad):
# output/.work/old_51cd206d/thumbnails/ + /tmp/vea-thumbs/dog_text.png
```
