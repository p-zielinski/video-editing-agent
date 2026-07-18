# Pipeline Recovery System

> Last updated: 2026-07-18
> Status: done

## Problem & goal

Remove silent DeepFilterNet→ffmpeg fallback. Every pipeline failure should persist an execution ledger and a runnable recovery plan (`17-recovery-plan.json`).

## Key files

| Area | Path |
|------|------|
| Recovery lib | `src/lib/recovery/` |
| Execution state schema | `src/schemas/execution-state.js` |
| Recovery plan schema | `src/schemas/recovery-plan.js` |
| Orchestrator hooks | `src/lib/recovery/orchestrator-hooks.js`, `src/pipeline/orchestrator.js` |
| Analysis collect mode | `src/lib/clip-concurrency.js`, `src/pipeline/analysis-phase.js` |
| Audio hard fail | `src/lib/audio-enhancement/providers/deepfilternet.js` |
| CLI recover | `src/cli.js` |
| Doctor | `src/lib/batch-doctor.js` |

## Progress

- [x] Recovery schemas + lib
- [x] Orchestrator ledger + recovery plan on fail
- [x] Clip concurrency collect mode
- [x] DeepFilterNet hard fail
- [x] CLI `recover` + doctor RECOVERY_PLAN_PENDING
- [x] AUD-QUAL-06 + tests

## Verification

```bash
npm test -- src/lib/recovery src/lib/clip-concurrency.test.js src/pipeline/orchestrator.recovery.test.js src/lib/audio-enhancement/providers/deepfilternet.test.js
node src/cli.js recover --batch-id <id>
node src/cli.js doctor --batch-id <id>
```
