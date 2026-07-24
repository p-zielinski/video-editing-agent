# Shorts outro bracket Zod stub fix

> Last updated: 2026-07-23
> Branch: (local)
> Status: done (awaiting user re-run)

## Problem & goal

Batch `51cd206d` failed at `direct` → `segment_director seg001` with Zod:
- `shortsOutroBracket.text` empty string
- `shortsOutroBracket.endAtOutputSec` = 0

LLM returned disabled stub `{ enabled: false, text: "", endAtOutputSec: 0, ... }`.

## Decisions

- 2026-07-23: Delete object when `enabled: false` (matches enricher). Schema preprocess strips `""` / `<=0` as belt-and-suspenders.
- Delete poisoned `segment_director__*seg001*` cache; keep valid `seg002`.

## Progress

- [x] `sanitizeShortsOutroBracket` + schema preprocess
- [x] Unit tests (live shape)
- [x] Delete seg001 LLM cache + rejected
- [ ] User re-run from `direct`

## Verification

```bash
node src/cli.js run --batch-id 51cd206d --from-step direct --render --render-profile production --force --context "Nagrane dzień przed 30. urodzinami — osobisty vlog o nadziei na nadchodzące trzydzieste lata, refleksji i tym, co zostaje z mijającego czasu."
```

Do **not** pass `--reuse-llm-cache`.
