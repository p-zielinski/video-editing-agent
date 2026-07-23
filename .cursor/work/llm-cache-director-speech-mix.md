# LLM cache CLI-only + director quality + speech-aware mix

> Last updated: 2026-07-23
> Branch: `main`
> Status: done

## Problem & goal

1. `LLM_REUSE_CACHE=1` w `.env` zawsze włączał reuse — usunięte; tylko `--reuse-llm-cache`.
2. Audyt jakości reżysera na `51cd206d`.
3. Speech-aware music ducking (mowa → głęboki duck, cisza → płytki).

## Progress

- [x] Remove `LLM_REUSE_CACHE` from `.env`; docs CLI-only — Reviewer APPROVED
- [x] Director quality audit → `.cursor/work/director-quality-audit-51cd206d.md` — Reviewer APPROVED
- [x] Speech-aware mix + reject-safe enhancement accepts — Reviewer APPROVED
- [x] Final verification

## Key deliverables

| Item | Path |
|------|------|
| Director audit | `.cursor/work/director-quality-audit-51cd206d.md` |
| Speech ducking | `src/editorial/speech-ducking.js`, `.cursor/work/speech-aware-mix.md` |
| LLM cache | CLI `--reuse-llm-cache` only |

## Notes for user

- Review w 70 ms przy `--reuse-llm-cache` + istniejącym `09-final` = skip artefaktów, nie „świeży” critic.
- Bez flagi i bez `.env` LLM cache **nie** jest reużywany (pliki w `llm-cache/` nadal są zapisywane na przyszły opt-in).
- DPDFNet = denoise VO; ducking = muzyka pod głosem z okien speech.
- Główny problem montażu: zatrute L1 (jeden cacheKey null → wszystkie sceny = clip01) + ogromne briefy segment/drill-down.

## Verification

```bash
node --test tests/editorial/speech-ducking.test.js
# 10 pass
```
