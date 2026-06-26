# EditRecipe v2.1 Creativity Layer — Critique

> Data: 2026-06-26  
> Autor: subagent review (read-only pass)

## Executive summary

| Area | Verdict | Notes |
|------|---------|-------|
| Plan vs implementation | **Partial** | Core deliverables exist; CI catalog validation, spec update, fixer/drill-down, `safe`-level gating missing |
| `techniques/` catalog | **Partial** | 19 techniques, good structure; pack curation undocumented; no runtime schema validation |
| `src/editorial/*` budget | **Partial** | Tuning port mostly correct; dead code in `minZoomGapSec`; zoom budget scope too narrow |
| `creative-moments.js` validators | **Fail** | V21-03 level gate inverted; several rules too weak or untested |
| Director/critic integration | **Partial** | Initial brief injects catalog; drill-down/fixer/critic LLM lack full context |
| Tests | **Partial** | 67 pass; V21-04/05/07 and integration gaps |
| Schema / backward compat | **Pass** | v2.0/v2.1 coexist; JSON export includes creative fields |
| Security / extensibility | **Pass** | Add-file model works; missing CI guardrails |

---

## Critical issues (must fix)

### 1. `requiresCreativityLevel` gate is inverted — false negatives

`src/validators/creative-moments.js` — `allowedCreativityLevels` for `balanced` includes `"bold"`, so techniques like `match_cut` (`requiresCreativityLevel: "bold"`) pass at `balanced`. Same for `snap_zoom` / `whip_pan` (`"shorts"`) at `bold`.

**Fix:** Compare ordered levels (`safe < balanced < bold < shorts`) or require minimum level when specified.

### 2. Zoom budget bypass via non-zoom camera techniques

`ken_burns_light` and `reframe_follow_subject` are not counted toward `maxZoomMoments`, `minZoomGapSec`, or `maxTotalZoomDutySec`.

**Fix:** Budget by `category === "camera"` or explicit `countsTowardZoomBudget` in technique constraints.

### 3. No CI validation of catalog vs `_schema.json`

Plan requires test CI walidujący wszystkie pliki vs `_schema.json`. Broken technique JSON can ship silently.

**Fix:** Add `tests/editorial/technique-catalog-schema.test.js` with AJV.

### 4. `directorDrillDown` drops creativity context

Drill-down payload lacks `techniqueCatalog`, `creativityBudget`, `creativityProfile`. Refine pass can drop or hallucinate `creativeMoments`.

**Fix:** Inject catalog + budget into drill-down payload.

### 5. Fixer has no v2 / creative-moment guidance

`src/agents/fixer.js` uses `prompts/v1/fixer.md` only. V21 issues from critic are not reliably corrected.

**Fix:** Add `prompts/v2/fixer.md` with V21 repair rules; branch on recipe version.

---

## Important improvements (should fix)

### Validators

| Gap | Detail |
|-----|--------|
| V21-04 gap semantics | Uses start-to-start, not end→start; overlapping moments can pass |
| V21-05 per-output | `maxPerOutputMinutes` uses global duration, not per `outputId` |
| Missing structural checks | No `outputEndSec > outputStartSec`; no valid `outputId`; moment not inside segment bounds |
| Params | Unknown keys ignored; required params with defaults not enforced when omitted |
| V21-07 severity | Warnings only — critic may approve unanchored zooms |
| `anchorWordId` | Never validated against word index |

### Budget

- Dead code in `minZoomGapSec`: `Math.max(15, 30, …)` — `15` never wins
- `allowMidSentenceCuts` inconsistency between `parseCreativityFromContext` and `computeCreativityBudget`
- `safe` level not enforced in catalog — full pack still injected

### Catalog / packs

- `defaultCreativityLevel` in pack JSON never read by loader
- `youtube_vlog_2026` omits `zoom_slow_push` without documentation
- `format-catalog-for-prompt.js` omits param ranges/defaults

### Integration

- Critic LLM lacks technique catalog
- `recipe-v2-validator.test.js` has zero creative tests
- `EDITING_RECIPE_V2_SPEC.md` has no v2.1 section

### Tests — coverage holes

Missing: V21-04, V21-05, V21-07, level gate for match_cut/snap_zoom, validateRecipeV2 integration, directorDrillDown context

---

## Nice-to-haves

- Auto-discover techniques from filesystem
- Pack JSON schema + validation
- `creativityProfile.level` → auto-set `allowMidSentenceCuts`
- Include `whenToAvoid` + param defaults in prompt table
- Duplicate `momentId` detection
- `needsHumanReview` auto-flag for spatial issues

---

## Recommended fixes (priority order)

1. Fix `validateCreativityLevelGate` — minimum level comparison
2. Expand zoom/camera budget to all camera techniques
3. Add catalog JSON Schema CI test
4. Inject catalog + budget into `directorDrillDown`
5. Add `prompts/v2/fixer.md` + version-aware fixer
6. Harden validators: end>start, valid outputId, end-to-start gaps, per-output V21-05
7. Align `allowMidSentenceCuts` derivation
8. Add missing tests (V21-04/05/07, level gate, validateRecipeV2 integration)
9. Update `EDITING_RECIPE_V2_SPEC.md` with v2.1 section
10. Enrich `formatCatalogForPrompt` with param ranges; optional `safe`-level technique filtering
