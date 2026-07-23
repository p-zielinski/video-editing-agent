# Main subtitle Whisper echo + short duplicate opening

> Last updated: 2026-07-19
> Branch: `main`
> Status: done (Reviewer approved; render-ready)

## Problem & goal

1. **Main** `main_16x9_16x9.mp4`: first ~60s subtitles show Whisper **prompt echo** ("Zapisz każde słowo… eufemizmów…") instead of speech. Real speech starts ~61s (`Myślę`).
2. **Short** `short_9x16_9x16.mp4`: opening scene plays **twice** — recipe had `short_001` and `short_002` both `clip40` 0–5s.
3. **AI hook**: not on timeline — `aiVideoEnabled: false` / artifact `disabled`; leftover stub `generated/ai_hook_01.mp4` exists; director still `aiHookDecision: accept` but enricher correctly skips.

**Done** = prompt echoes stripped from words + ASS; duplicate adjacent segments sanitized; batch recipe fixed + re-render.

## Scope

- **In scope:** whisper prompt-echo strip, ASS filter, duplicate-segment sanitize, patch batch words/recipe, re-render.
- **Out of scope:** enabling Kling AI video for this batch; full re-transcribe of all clips unless needed.

## Key files

| Area | Path | Role |
|------|------|------|
| Echo strip | `src/lib/whisper-prompt-echo.js` | n-gram / island detection |
| Words | `01-words-clip16.json` | patched — first word `Myślę` @ 60.94s |
| ASS | `src/render/ass-subtitles.js` | `isBoilerplateSubtitleWord` + echo safety net |
| Transcribe | `src/lib/transcribe.js`, `src/pipeline/steps/transcribe.js` | strip on Whisper response + global cache republish |
| Sanitize | `src/editorial/recipe-hard-error-sanitize.js` | `sanitizeAdjacentDuplicateSegments` |
| Short recipe | `09-edit-recipe-final.json` | duplicate `short_002` removed, timeline compacted |
| AI | `05e-ai-video.json` | disabled — expected |

## Decisions

- 2026-07-19: Strip prompt echoes at **word-index** level (source of truth) + keep ASS filter as safety net using distinctive prompt tokens / n-gram runs.
- 2026-07-19: Sanitize adjacent duplicate video windows on short/main timelines; compact output times; drop creative moments inside removed window; shift moments after removal.
- 2026-07-19: AI hook missing is expected with `aiVideoEnabled: false`; stub file is leftover, not used. **No code change** — `enrichRecipeAiHook` already gates on `status === "succeeded"`; director `accept` is harmless when artifact disabled.

## Progress

- [x] Root-cause analysis
- [x] Implement strip + sanitize + tests
- [x] Patch batch `51cd206d` words + draft/final recipes (validate 0 errors)
- [x] Reviewer verify tests + batch artifacts (0 validation errors, 28/28 tests pass)
- [ ] Re-render main + short (parent: `node src/cli.js render --batch-id 51cd206d --force --render-profile production`)

## Batch patch results (`51cd206d`)

**clip16 words before:** `Zapisz`, `każde`, `słowo`, `włącznie`, `z`, `zająknięciami` … until ~60.94s  
**clip16 words after:** `Myślę`, `że`, `osiągnęłem`, `mniej`, `niż`, `nie` … (wordIds reassigned)

**Short timeline before:** `short_001` clip40 0–5 @ 0–5, `short_002` clip40 0–5 @ 5–10, `short_003` clip24 @ 10–18  
**Short timeline after:** `short_001` clip40 0–5 @ 0–5, `short_003` clip24 @ 5–13, `short_004` clip28 @ 13–30

## Reviewer notes (2026-07-19)

- **APPROVED** — strip logic keeps real speech (`słowo` in synthetic clip16 fixture @ 62.5s); patched clip16 has 0 echo tokens, restrip is idempotent.
- Short: no adjacent duplicate clip40 windows; hooks at 0.116 align with `short_hook_01` overlay @ 0.12.
- Main: ~61s silent clip16 before first subs @ 60.94s is acceptable (cold open + rewind); do **not** shift `main_001` `videoInSec`.
- AI hook disabled expected; `enrichRecipeAiHook` gates on `status === "succeeded"`.
- Optional follow-up (not blocking): local `shouldUseCachedClipArtifact` hit returns words without strip — only affects pre-fix batches re-run without `--force`; global-cache path already republishes stripped.

## Next steps

1. `node src/cli.js render --batch-id 51cd206d --force --render-profile production`

## Verification

```bash
node --test src/render/ass-subtitles.test.js src/lib/whisper-prompt-echo.test.js tests/editorial/recipe-hard-error-sanitize.test.js
node src/cli.js render --batch-id 51cd206d --force --render-profile production
```
