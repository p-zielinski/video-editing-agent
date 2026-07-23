# Vision timeout + recovery failedStep fix

> Last updated: 2026-07-19
> Status: done

## Problem & goal

clip16 (83 keyframes) timed out at fixed 30 min during vision. Recovery plan showed `failedStep: transcribe` instead of `vision`.

## Key files

| Area | Path |
|------|------|
| Timeout | `src/pipeline/steps/vision.js` — `resolveVisionPythonTimeoutMs` |
| Recovery | `src/lib/recovery/plan-writer.js` — `error?.step` first |
| Tests | `vision.test.js`, `plan-writer.test.js` |

## Resume batch 51cd206d

```bash
npm run full -- --batch-id 51cd206d --from-step vision \
  --context "wyjazd w góry, na dzień przed moimi 30stymi urodzinami, próba podejścia do tego jak do rozliczenia się z lat 20stych i próba zyczenia sobie lepszych lat 30stych, lata 20 to moze nie czas porazek ale z pewnością niewykorzystanych szans"
```

- 39 vision artifacts cached; only clip16 runs (~67 min timeout budget)
- Then objects for all clips missing objects artifacts

## Verification

```bash
node --test src/pipeline/steps/vision.test.js src/lib/recovery/plan-writer.test.js
```
