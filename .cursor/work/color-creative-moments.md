# Color: timed narrative creative moments

> Last updated: 2026-07-14
> Branch: `main`
> Status: done

## Problem & goal

Director needs rare, time-ranged color shifts (desaturate / saturation boost) tied to narrative beats — distinct from global `colorGrade` LUT/EQ on the whole output. Render via creative pass `eq` saturation with `between(t,start,end)`; validate narrative intent, no overlap, and density caps.

## Scope

- **In scope:** `color` technique category, `color_desaturate` / `color_saturation_boost`, `technique-to-ffmpeg` timed EQ helper, `creative-moments` guardrails, `director.md` guidance, packs + catalog, targeted tests.
- **Out of scope:** audio changes, AI hook, timeCuts, global `colorGrade` / LUT pass, pass order changes.

## Key files & context

| Area | Path | Role |
|------|------|------|
| Schema | `techniques/_schema.json` | `color` category enum |
| Techniques | `techniques/color/*.json` | Params, narrativeFunctions, renderSupport |
| Catalog | `techniques/catalog.meta.json`, `techniques/packs/*.json` | Registration + pack enablement |
| Render | `src/render/technique-to-ffmpeg.js` | `buildTimedSaturationFilter` helper |
| Capabilities | `src/render/render-capabilities.js` | `full` render support |
| Validation | `src/validators/creative-moments.js` | V21-16 / V21-20 / V21-21 color guardrails |
| Prompts | `prompts/v2/director.md`, `prompts/v2/critic.md`, `prompts/v2/fixer.md` | Guidance, critic codes, corrective actions |
| Tests | `technique-to-ffmpeg`, `ffmpeg-creative`, `render-capabilities`, editorial tests | TDD |

## Decisions

- 2026-07-14: Saturation-only timed EQ in creative pass; `saturation=1-amount` (desaturate) and `saturation=1+boost` (boost); outside window saturation=1.
- 2026-07-14: Reuse V21-16 for missing/inadequate `narrativeIntent`; V21-20 overlap, V21-21 density (60 s / max 2) — warnings except param range stays V21-02 error.
- 2026-07-14: Do not mask invalid recipes at renderer — validator enforces semantics; renderer applies clamped values only.
- 2026-07-14: Reviewer correction — document V21-20/V21-21 in critic/fixer with warning severity, exact-touch allowance, and density counted independently per output.

## Progress

- [x] Handoff file created
- [x] Tests added/updated (TDD)
- [x] Implementation complete
- [x] Reviewer prompt corrections and cross-output density test
- [x] Targeted test run & handoff updated
- [x] Stage 4/4 integration QA (export-schemas, full suite, e2e, diff audit)

## Next steps

1. None for this feature — shipped.

## Blockers / open questions

- None for feature correctness.
- Full `npm test` has unrelated failures (music catalog / sfx / artifact versions / mocked pipeline queue) — color-targeted tests all pass.

## Verification

### Stage 4/4 integration (2026-07-14)

```bash
npm run export-schemas
# Deterministic — second run produces identical schema files

npm test
# 1797 pass / 21 fail / 6 skip — no color-regression failures

npm run test:e2e
# 44 pass / 6 fail / 5 skip — render creative pass runs; no color-specific failures

git diff --check
# OK
```

### Reviewer follow-up final QA (2026-07-14)

```bash
# Combined Audio + Color + AI Hook bundle after test-hygiene/canonical fixes
# 246/246 pass

# Focused ingest hygiene + canonical/reconstruct/routing bundle
# 65/65 pass
```

No untracked `tests/lib/*-ingest-*` artifacts remain after the tests. The full-suite baseline was not rerun and remains 1797 pass / 21 fail / 6 skip; E2E remains 44 pass / 6 fail / 5 skip with the previously documented unrelated failures.

### Color-targeted (all pass)

```bash
node --test src/render/technique-to-ffmpeg.test.js src/render/ffmpeg-creative.test.js \
  src/render/render-capabilities.test.js tests/editorial/creative-moments.test.js \
  tests/editorial/artistic-editing-grammar.test.js tests/editorial/load-technique-catalog.test.js \
  tests/editorial/format-catalog-for-prompt.test.js
# 114/114 pass (subset of 246/246 combined feature bundle)
```

IDE diagnostics on changed render/validator/prompt files: no linter errors.
