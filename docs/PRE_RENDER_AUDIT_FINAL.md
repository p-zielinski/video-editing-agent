# Pre-render Pipeline — Final Audit

> Data: 2026-06-26  
> Testy: **405** unit/contract + **10** e2e = **415**  
> Cel: **9.5/10 pre-render**  
> **Wynik: 9.1/10**

## Executive summary

Sprint 9.5 zamknął większość luk z audytu 8.3 → **9.1**. Pipeline analizy i reżyserii jest gotowy produkcyjnie jako **generator planu montażu** (EditRecipe JSON). Brakuje **0.4 pkt** do 9.5: orchestrator E2E przez `runPipeline`, live batch na prawdziwym materiale, keyframes w fixture’ach.

---

## Scorecard

| Obszar | v8.3 | Final | Cel |
|--------|------|-------|-----|
| Pipeline | 8.7 | **9.2** | 9.5 |
| Video understanding | 7.8 | **8.0** | 9.5 |
| Index & abstrakcja | 8.3 | **9.0** | 9.5 |
| Agenci + E2E proof | 8.5 | **9.0** | 9.5 |
| EditRecipe plan | 8.6 | **8.8** | 9.5 |
| Techniki & opcje | 8.2 | **8.7** | 9.5 |
| Walidacja | 8.8 | **9.0** | 9.5 |
| Testy & CI | 8.4 | **9.0** | 9.5 |
| Dokumentacja | 8.2 | **9.0** | 9.5 |
| **Ogółem** | **8.3** | **9.1** | **9.5** |

---

## Zaimplementowano w sprincie 9.5

| Element | Status |
|---------|--------|
| E2E agent loop (mock OpenAI abstract→review) | ✅ `tests/e2e/agent-loop.test.js` |
| Critic/fixer loop E2E | ✅ `tests/e2e/critic-fixer-loop.test.js` |
| `--face-live` CLI | ✅ |
| Director `l1SceneSummaries` (≤5 scen) | ✅ |
| Vision fixtures PL (mini-day) | ✅ |
| EditRecipe **v2.3** `audioMixPlan` | ✅ |
| batchContext DSL w docs | ✅ |
| CI: `npm test` + `test:e2e` | ✅ |
| validateBrollTopicIndex tests | ✅ |
| Graf artefaktów + stale invalidation | ✅ |
| `cli report --batch-id` | ✅ |
| [`PRE_RENDER_PIPELINE.md`](PRE_RENDER_PIPELINE.md) | ✅ kanoniczny |

---

## Dlaczego nie 9.5 (0.4 pkt)

1. **Brak orchestrator E2E** — `agent-loop` startuje od fixture timeline, nie `runPipeline` od ingest
2. **Brak live batch** — nie ma udokumentowanego przebiegu Whisper+Florence na prawdziwych klipach
3. **mini-day bez `02-keyframes-*`** — łańcuch face-detect nie ćwiczony w fixture end-to-end
4. **Plan montażu** — brak SFX, color grade w schemacie; V23 tylko V23-01 (warning)

---

## Droga 9.1 → 9.5 (bez renderu)

| # | Zadanie | Szacunek |
|---|---------|----------|
| 1 | `runPipeline` E2E ze stub inbox + mock OpenAI | 2–3 dni |
| 2 | `02-keyframes-*` w mini-day fixture | 0.5 dnia |
| 3 | 1 live batch + snapshot `10-batch-quality-report.json` | 1 dzień |
| 4 | V23: walidacja segmentów music, LUFS range | 1 dzień |
| 5 | Opcjonalnie: `sfxPlan[]` w v2.4 schema | 2 dni |

---

## Komendy

```bash
npm test              # 405 testów
npm run test:e2e      # 10 testów (agent loop, critic-fixer, pipeline)
node src/cli.js report --batch-id <id>
node src/cli.js full --input ./inbox --context "vlog; creativity: balanced"
```

## Dokumentacja

- **Kanoniczna:** [`docs/PRE_RENDER_PIPELINE.md`](PRE_RENDER_PIPELINE.md)
- **Historia:** [`docs/PRE_RENDER_AUDIT_2026-06-26.md`](PRE_RENDER_AUDIT_2026-06-26.md)

---

## Ocena 10.0

Niemożliwa bez renderu ffmpeg — zoom, overlay, audio mix, napisy to egzekucja, nie plan. Pre-render **10.0** wymagałby też live ML quality na stałe w CI (GPU).
