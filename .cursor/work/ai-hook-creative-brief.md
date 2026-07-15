# AI Hook: L3 creative brief & director accept flow

> Last updated: 2026-07-14
> Branch: `main`
> Status: done

## Problem & goal

Summarizer L3 should optionally emit a structured `hookCreativeBrief` that drives deterministic Kling prompt compilation and anti-spoiler scene selection. Director explicitly accepts or rejects the generated hook asset via `outputs[].aiHookDecision`; enricher inserts only on accept with matching `clipId`. Canonical-first segment routing ensures only the primary Super Director segment evaluates the hook.

## Scope

- **In scope:** `HookCreativeBriefSchema`, summarizer L3, `hook-prompt-compiler`, `ai-hook-scene` selection, `hook-planner`, `aiHookDecision`, `resolveCanonicalSegmentOrder`, segment-director routing, recipe-merge, `ai-hook-enrich`, prompts, tests, `docs/PIPELINE.md`.
- **Out of scope:** new hook-strategist LLM, multi-variant Kling, `agents.js` brief wiring, shared `shorts-retention.js` changes, timeCuts, audio/color/global grade.

## Key files & context

| Area | Path | Role |
|------|------|------|
| L3 schema | `src/schemas/edit-recipe.js` | `HookCreativeBriefSchema` on `AbstractL3Schema` |
| Summarizer | `src/agents/summarizer.js`, `prompts/v2/summarizer.md` | Optional L3 brief generation |
| Compiler | `src/lib/ai-video/hook-prompt-compiler.js` | Deterministic Kling prompt from brief |
| Scene pick | `src/lib/ai-video/ai-hook-scene.js` | Anti-spoiler ranking (local, not retention) |
| Planner | `src/lib/ai-video/hook-planner.js` | Uses compiler + scene selection |
| Recipe | `src/schemas/edit-recipe-v2.js` | `outputs[].aiHookDecision` |
| Director export | `src/schemas/export-director-schema.js`, `prompts/v2/director.md` | accept/reject contract |
| Routing | `src/lib/segment-catalog.js`, `src/agents/segment-director.js` | Canonical first gets `aiHook` |
| Merge | `src/lib/recipe-merge.js` | `aiHookDecision` from canonical first partial |
| Enrich | `src/editorial/ai-hook-enrich.js` | Insert only on explicit accept |

## Decisions

- 2026-07-14: Brief always optional on L3 (no `aiVideo` flag); legacy L3 without brief keeps compiler fallback matching prior prompt shape.
- 2026-07-14: AI hook scene selection is local (`ai-hook-scene.js`); do not use `resolveBestHookScene` (cold-open payoff is a spoiler risk).
- 2026-07-14: `enrichRecipeAiHook` requires `aiHookDecision.action === "accept"` and exact `clipId` match; existing `ai_hook` timeline segments are never removed.
- 2026-07-14: `resolveCanonicalSegmentOrder` computed in `agents.js` after `resolveSegmentPicks`; stored on `superPlan.canonicalSegmentOrder`.
- 2026-07-14: Reviewer fix — `HookCreativeBriefSchema` is an exportable discriminated union, so generated JSON Schema requires `unexpectedElement` only for `intentionally_unexpected`.
- 2026-07-14: Reviewer fix — segment-director trusts only prepared `canonicalSegmentOrder`; it cannot reconstruct canonical-first from unfiltered `segmentPicks`.

## Progress

- [x] Handoff file created
- [x] Schema + summarizer L3 brief
- [x] Compiler + planner + scene selection
- [x] Director decision + canonical routing + merge + enrich
- [x] Tests + export-schemas + PIPELINE.md
- [x] Stage 4/4 integration QA (export-schemas, full suite, e2e, diff audit)

## Next steps

1. Live batch QA with `--ai-video-stub` (optional, manual).
2. Repo-wide: fix mocked E2E mock queues for `runMusicCurator` (15 catalog candidates now consume director slot) — out of AI-hook scope.

## Blockers / open questions

- None for feature correctness.
- Mocked pipeline E2E failures (`outputs` undefined) stem from `runMusicCurator` LLM call dequeuing director recipe from `buildMiniDayAgentLoopResponses` — pre-existing music-catalog expansion, not AI-hook changes.

## Verification

### Stage 4/4 integration (2026-07-14)

```bash
npm run export-schemas
# Exported 14 JSON Schema files; AbstractionBundle + EditRecipeV2 updated; second run stable

npm test
# 1797 pass / 21 fail / 6 skip — no ai-hook regression failures

npm run test:e2e
# 44 pass / 6 fail / 5 skip — agent-loop/full-pipeline failures unrelated (music curator queue)

git diff --check
# OK
```

### Reviewer follow-up final QA (2026-07-14)

- `reconstructSuperPlanFromRecipe` now rebuilds `canonicalSegmentOrder` through shared `resolveCanonicalSegmentOrder`.
- Available canonical IDs are the intersection of recipe-selected `narrativeProfile.segments`, known L2 IDs, and L2 scenes actually referenced by the union of every output timeline. When the profile is absent, timeline presence still limits reconstructed picks.
- Timeline segments have no direct L2 ID after merge; reconstruction maps both `videoRef.sceneId` and `audioRef.sceneId` back through `abstraction.L2[].sceneIds`.
- Added a focused review/fixer reconstruction test: `narrativeProfile` contains `seg_rejected` first, while two outputs reference only selected L2 scenes; canonical order excludes rejected and preserves both selected segments.
- Added reliable `t.after` cleanup to Pixabay music/SFX ingest temp-dir tests and removed only untracked generated ingest artifacts.

```bash
node --test tests/lib/pixabay-music-ingest.test.js tests/lib/pixabay-sfx-ingest.test.js \
  src/pipeline/steps/agents.test.js src/lib/segment-catalog.test.js \
  src/lib/recipe-merge.test.js tests/agents/segment-director.test.js \
  src/editorial/ai-hook-enrich.test.js
# 65/65 pass

# Combined Audio + Color + AI Hook bundle
# 246/246 pass

git ls-files --others --exclude-standard \
  'tests/lib/music-ingest-*' 'tests/lib/sfx-ingest-*'
# no output — no untracked ingest artifacts remain
```

The full-suite baseline was not rerun because these fixes are test hygiene and targeted reconstruction only. Its documented unrelated result remains `npm test`: 1797 pass / 21 fail / 6 skip; `npm run test:e2e`: 44 pass / 6 fail / 5 skip.

Reviewer blocker re-verification:

```bash
node --test src/pipeline/steps/agents.test.js src/lib/segment-catalog.test.js \
  src/lib/recipe-merge.test.js tests/agents/segment-director.test.js
# 45/45 pass
```

### AI-hook targeted (all pass)

```bash
node --test src/lib/ai-video/hook-prompt-compiler.test.js \
  src/lib/ai-video/ai-hook-scene.test.js \
  src/lib/ai-video/hook-planner.test.js \
  src/agents/summarizer.test.js \
  src/lib/segment-catalog.test.js \
  src/lib/recipe-merge.test.js \
  src/editorial/ai-hook-enrich.test.js \
  tests/agents/segment-director.test.js \
  tests/contracts/export-director-schema.test.js \
  tests/contracts/artifact-schema-contract.test.js \
  src/pipeline/steps/ai-video.test.js
# 81/81 pass (incl. ai-video pipeline step tests)

# Combined three-feature bundle
# 246/246 pass
```

IDE diagnostics on changed ai-hook files: no linter errors.
