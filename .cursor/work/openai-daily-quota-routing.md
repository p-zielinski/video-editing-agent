# OpenAI daily quota routing

> Last updated: 2026-07-18
> Branch: local worktree
> Status: done

## Problem & goal

Wykorzystać darmowe dzienne pule OpenAI (premium 250k / mini 2.5M tokenów), śledzić zużycie per projekt i automatycznie obniżać tier modelu po wyczerpaniu limitu.

## Scope

- **In scope:** daily tracker, runtime router, integracja chatJson/agents, observability, env docs
- **Out of scope:** billing API OpenAI, zmiana modeli Whisper/embeddings

## Key files & context

| Area | Path | Role |
|------|------|------|
| Daily tracker | `src/lib/openai-daily-usage.js` | Globalny licznik tokenów + lockfile |
| Model router | `src/agents/openai-model-router.js` | Downgrade chains + 429 handling |
| Chat client | `src/agents/openai-client.js` | `chatJson` z role/quota |
| Batch usage | `src/lib/gpt-usage-log.js` | Per-batch `16-gpt-usage.json` + flush helper |
| Orchestrator | `src/pipeline/orchestrator.js` | Tracker init + wcześniejszy zapis usage |
| Batch doctor | `src/lib/batch-doctor.js` | Raport dziennego quota |

## Decisions

- 2026-07-18: Storage `output/.openai-usage/daily/YYYY-MM-DD.json` + lockfile
- 2026-07-18: Polityka `balanced`, `OPENAI_QUOTA_ON_EXHAUSTED=downgrade`
- 2026-07-18: Fixer escalation bez auto-downgrade → `PREMIUM_QUOTA_REQUIRED`

## Progress

- [x] Phase 0: `.env.example` dokumentacja
- [x] Phase 1: daily tracker + orchestrator wiring
- [x] Phase 2: model router + chatJson + agenty
- [x] Phase 3: observability (Whisper, embeddings, thumbnails, safety, batch-doctor)
- [x] README / PIPELINE update

## Włączenie

```dotenv
OPENAI_QUOTA_TRACKING=1
OPENAI_MODEL_DOWNGRADE_ENABLED=1
```

## Verification

```bash
node --test src/lib/openai-daily-usage.test.js
node --test src/agents/openai-model-router.test.js
node --test src/lib/gpt-usage-log.test.js src/lib/batch-doctor.test.js
```
