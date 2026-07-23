# Director quality fix + intentional ambient

> Last updated: 2026-07-23
> Status: done (cache semantics + brief slim offline; live abstract optional); **brief-slim done offline**

## Problem & goal

1. Director quality: L1 cache poison + integrity gate.
2. Intentional ambient (“posłuchajcie… ptaki”) must survive denoise/mix.
3. Segment/drill-down prompt bloat after L1 is healthy — compact briefs (<40k est. tokens/segment).

## Progress

- [x] Director L1 cacheKey + sceneId bind + integrity gate + force wipe — Reviewer APPROVED
- [x] Ambient audit (partial) → implement preserveAmbientAudio + render gates
- [x] EDL `preserveAmbientAudio` forwarding fix — Final Reviewer APPROVED
- [x] CLI/docs: rozdzielenie cache artefaktów vs LLM; recovery bez wymaganego `--force`
- [x] **Brief slim** (catalog compact, tighter audio, L1-aware words, slim drill-down) — fixture tests offline
- [ ] Live re-run abstract on `51cd206d` (user/ops)

## Brief slim (2026-07-23)

See `.cursor/work/brief-slim.md` for full metrics.

| Check | Result (fixture `abstract-diverse-l1`) |
|-------|----------------------------------------|
| Segment est. tokens | ~18.2k / budget 40k |
| Catalog chars | 9.1k → 3.0k (cap 4.5k) |
| Drill-down vs legacy | ~72% bytes (no `draftRecipe` / `outputSchema`) |

## Re-run director quality on batch

```bash
node src/cli.js run --batch-id 51cd206d --from-step abstract --to-step abstract
# integrity gate auto-rebuilds poisoned L1 without --force
# then direct → review → render as needed
```

`--force` = przelicz artefakt kroku mimo świeżego cache na dysku (opcjonalnie czyści L1/L2 llm-cache przy abstract).
`--reuse-llm-cache` = opt-in reuse zapisanych odpowiedzi LLM zamiast API, gdy krok się wykonuje.
Domyślnie: artefakty z cache jeśli OK; wywołania LLM świeże.

## Ambient behavior

| Layer | Behavior |
|-------|----------|
| Enricher | listen/bird cues → `preserveAmbientAudio` + reject denoise (flips auto-accept) |
| Render | enhanced WAV only for explicit `accept`; preserve → original |
| Mix | unduck music on showcase; soft-disable silence_beat |

## Key docs

- `.cursor/work/director-quality-audit-51cd206d.md`
- `.cursor/work/intentional-ambient-audit.md`
- `.cursor/work/brief-slim.md`
