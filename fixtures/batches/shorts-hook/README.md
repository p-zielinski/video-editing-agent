# shorts-hook fixture batch

Single-clip fixture optimized for **shorts retention** validation (hook window, retention beats).

## Scenario

Vertical hook clip (~55s source) cut to a 45s short with:
- Hook moment + hook overlay in the first 3 seconds (`V22-01`, `V22-02`)
- Two retention beats at ~25s and ~40s cadence (`V22-03`, `V22-04`)

## Key artifacts

| File | Pipeline step | Role |
|------|---------------|------|
| `00-manifest.json` | ingest | Batch metadata |
| `00-scene-catalog.json` | ingest | Single clip, 2 scenes |
| `01-words-clip01.json` | transcribe | Word index with hook speech in scene 1 |
| `04-objects-clip01.json` | objects | Face/subject detections for spatial refs |
| `05-timeline-index.json` | index | Single clip, 2 scenes, hook speech in scene 1 |
| `05a-clip-registry.json` | clip_profile | `aroll_primary` |
| `05b-topic-index.json` | topic_index | Minimal topic index |
| `05c-spatial-index.json` | spatial_index | Anchor bboxes for reframing |
| `06-abstract.json` | abstract | L3 summary references hook narrative |
| `expected-recipe-v2.json` | direct/review | Golden short recipe with `shortsRetentionProfile` + `creativeMoments` |
| `expected-validation.json` | review | Expects 0 validator errors including V22 checks |

### Artefakty nieobecne (skrócony fixture)

Ten katalog nie zawiera pełnej analizy per-clip: brak `01b-audio-analysis-*`, `01c-meta-commands-*`, `02-keyframes-*`, `03-vision-*`, `03b-twelvelabs-*`, `04a-faces-*`, `05d-audio-index.json`, `05e-ai-video.json`. Testy kontraktowe i walidatory operują na minimalnym zestawie indeksów + golden recipe.

## Notes

`creativityProfile.maxTechniqueDensityPerMin: 2` raises the technique budget so four retention moments pass `V21-05` on a ~45s short.
