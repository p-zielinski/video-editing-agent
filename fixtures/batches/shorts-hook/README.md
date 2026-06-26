# shorts-hook fixture batch

Single-clip fixture optimized for **shorts retention** validation (hook window, retention beats).

## Scenario

Vertical hook clip (~55s source) cut to a 45s short with:
- Hook moment + hook overlay in the first 3 seconds (`V22-01`, `V22-02`)
- Two retention beats at ~25s and ~40s cadence (`V22-03`, `V22-04`)

## Key artifacts

| File | Role |
|------|------|
| `05-timeline-index.json` | Single clip, 2 scenes, hook speech in scene 1 |
| `06-abstract.json` | L3 summary references hook narrative |
| `expected-recipe-v2.json` | Golden short recipe with `shortsRetentionProfile` + `creativeMoments` |
| `expected-validation.json` | Expects 0 validator errors including V22 checks |

## Notes

`creativityProfile.maxTechniqueDensityPerMin: 2` raises the technique budget so four retention moments pass `V21-05` on a ~45s short.
