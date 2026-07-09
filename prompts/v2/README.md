# v2 prompts — index

Canonical agent prompts for the current pipeline (`PROMPT_VERSION` defaults to `v2`). Legacy copies live under `prompts/v1/`.

| File | Agent module | GPT usage step | Task / payload |
|------|--------------|----------------|----------------|
| `summarizer.md` | `src/agents/summarizer.js` | `abstract` | `L1_scene_summary`, `L1_batch_summary`, `L2_segment_summary`, `L3_session_summary` |
| `super-director.md` | `src/agents/super-director.js` | `super_director` | `super_director_route` |
| `director.md` | `src/agents/director.js`, `src/agents/segment-director.js` | `direct`, `drill_down`, `segment_director` | `initial_draft`, `drill_down_refine`, `segment_director_draft` |
| `super-critic.md` | `src/agents/super-critic.js` | `super_critic` | `super_critic_cross_segment` |
| `critic.md` | `src/agents/critic.js` | `critic` | recipe review payload (`recipe`, `heuristicIssues`, `timelineCrossCheck`, …) |
| `fixer.md` | `src/agents/fixer.js` | `fixer` | repair payload (`recipe`, `issues`, `narrativeIssues`, …) |
| `thumbnail-strategist.md` | `src/agents/thumbnail-strategist.js` | (thumbnails step) | thumbnail plan from frame shortlist |
| `thumbnail-critic.md` | `src/agents/thumbnail-critic.js` | (thumbnails step) | thumbnail variant review |

**Director tasks** share `prompts/v2/director.md`:

- `initial_draft` — classic path, first pass
- `drill_down_refine` — second pass on selected scenes (classic or super path after merge)
- `segment_director_draft` — Super Director path, one L2 segment per call

**Recipe versions:** production default is EditRecipe **2.4** (`docs/RECIPE-VERSIONS.md`). Director prompt documents optional fields per version; segment director defaults omitted `version` to `2.4`.

**Related docs:** [`docs/PIPELINE.md`](../../docs/PIPELINE.md), [`docs/RECIPE-VERSIONS.md`](../../docs/RECIPE-VERSIONS.md), [`docs/CONTEXT.md`](../../docs/CONTEXT.md).
