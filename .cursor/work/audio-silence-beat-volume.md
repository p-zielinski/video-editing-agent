# Audio: silence_beat volumeFactor & hard mute

> Last updated: 2026-07-14
> Branch: `main`
> Status: done

## Problem & goal

Director needs a rare pattern-interrupt hard mute on voice without shortening the timeline or muting the music bed. Expose `volumeFactor` on `silence_beat` (0 = hard mute, default 0.3 = soft dip), run the audio mix pass when only audio creative moments exist, and align validators/prompts with hard mute vs soft dip semantics.

## Scope

- **In scope:** `silence_beat.json` param, `hasAudioMixMoments`, execute-render gating, validators V21-13 / V27-RENDER-05 exceptions, prompts v2, targeted tests.
- **Out of scope:** `dead-air-enrich.js`, `sfx-plan.js`, timeCuts, color pass, AI hook pipeline.

## Key files & context

| Area | Path | Role |
|------|------|------|
| Technique | `techniques/audio/silence_beat.json` | `volumeFactor` 0..1, default 0.3 |
| Render | `src/render/audio-mix.js` | Voice dip/mute filters, `hasAudioMixMoments` |
| Render | `src/render/execute-render.js` | `audio_mix` pass gating |
| Validation | `src/validators/creative-moments.js` | V21-13 hard mute vs soft dip |
| Validation | `src/validators/render-fidelity.js` | V27-RENDER-05 exception |
| Prompts | `prompts/v2/director.md`, `critic.md`, `fixer.md` | Hard mute guidance |
| Tests | `src/render/audio-mix.test.js`, validator & E2E tests | TDD coverage |

## Decisions

- 2026-07-14: Reuse `silence_beat` with explicit `volumeFactor` instead of a new technique; `0` is exact hard mute on voice only.
- 2026-07-14: Hard mute skips V21-13 silenceGap anchor and V27-RENDER-05 cuts warning; requires `retentionRole` hook|beat|payoff.
- 2026-07-14: Room tone / sting remain separate `sfxPlan` entries — not auto-added by silence_beat.
- 2026-07-14: Reviewer fix — the no-plan E2E deletes `audioMixPlan` and `sfxPlan` and removes output censorship, proving `hasAudioMixMoments` is the only `audio_mix` gate.
- 2026-07-14: Prompt wording mirrors the schema exactly: soft dip is `volumeFactor > 0` (default 0.3, maximum 1); hard mute is exactly `0`.

## Progress

- [x] Handoff file created
- [x] Tests added/updated (TDD)
- [x] Implementation complete
- [x] Targeted test run & handoff updated
- [x] Stage 4/4 integration QA (export-schemas, full suite, e2e, diff audit)

## Next steps

1. None for this feature — shipped. Parent plan stage 4 complete for Audio.
2. Optional: restore `assets/music/upbeat_vlog_01.mp3` or update golden fixtures to a catalog track id (repo-wide env gap, not audio-feature scope).

## Blockers / open questions

- None for feature correctness.
- **Unrelated full-suite noise:** `npm test` / `npm run test:e2e` report failures tied to missing `upbeat_vlog_01` in `assets/music/catalog.json` + file, expanded music catalog (`bpm` required), music-curator mock queue skew, sfx catalog contract, and artifact version `1.1` expectations. Audio-targeted tests and silence_beat E2E cases pass.

## Verification

### Stage 4/4 integration (2026-07-14)

```bash
npm run export-schemas
# Exported 14 JSON Schema files; second run identical (hash stable)

npm test
# 1797 pass / 21 fail / 6 skip (807 s) — failures unrelated to silence_beat (see Blockers)

npm run test:e2e
# 44 pass / 6 fail / 5 skip (771 s) — failures unrelated; silence_beat E2E cases pass

git diff --check
# OK (no conflict markers / whitespace errors)

# Feature-targeted bundle (audio + color + ai-hook)
node --test src/render/audio-mix.test.js src/validators/render-fidelity.test.js \
  tests/editorial/creative-moments-beat-sync.test.js tests/editorial/load-technique-catalog.test.js \
  ... (full list in color/ai-hook handoffs)
# 246/246 pass (includes all audio unit tests below)
```

### Reviewer follow-up final QA (2026-07-14)

```bash
# Combined Audio + Color + AI Hook bundle after test-hygiene/canonical fixes
# 246/246 pass

# Focused ingest hygiene + canonical/reconstruct/routing bundle
# 65/65 pass
```

Pixabay ingest tests now clean temporary directories through `t.after`; no untracked `tests/lib/*-ingest-*` artifacts remain. The full-suite baseline was not rerun and remains accurately documented above: 1797 pass / 21 fail / 6 skip, with 44 pass / 6 fail / 5 skip for E2E.

### Audio-targeted (all pass)

```bash
node --test src/render/audio-mix.test.js
# 42/42 pass

node --test src/validators/render-fidelity.test.js
# 8/8 pass

node --test tests/editorial/creative-moments-beat-sync.test.js
# 7/7 pass

node --test tests/editorial/load-technique-catalog.test.js
# 10/10 pass (incl. volumeFactor default 0.3)

node --test --test-name-pattern "silence_beat in audio mix" tests/e2e/render-shorts.test.js
# 2/2 pass — with and without audioMixPlan; hard mute applied
```

IDE diagnostics on changed render/validator files: no linter errors.
