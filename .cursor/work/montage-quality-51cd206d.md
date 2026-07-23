# Montage quality fixes (batch 51cd206d)

> Last updated: 2026-07-19
> Status: in progress (hotfixed topic_index; full abstract→review still needed)

## Problem & goal

Batch `51cd206d` — zły montaż: brak clip16, chronologia, napisy flash, stretch/crop. Naprawa warstw danych + render + guards.

## Hotfix: topic_index 400 empty embed

**Nie tak miało wyglądać.** Przy re-runie padło na `topic_index`:
`400 Invalid 'input[4]': input cannot be an empty string.`

### Root causes

1. **Pusty tekst do OpenAI embeddings** — `ai_hook_01` (z wcześniejszego `ai_video`) jest w katalogu jako silent clip → trafiał do B-roll scenes z pustym `buildSceneVisualText` (brak L1/vision/TL) → `input[4] === ""`.
2. **Zepsute L2** — cache `abstract__summarizerL2.json` miał `cacheKey: null`, więc wszystkie segmenty L2 dostały ten sam response `seg001` (3× duplikat). Dodatkowo `ai_hook` tworzył zbędny `seg003`.
3. **Cache nie wyczyszczony** — `rm *director*` w zsh (`nomatch`) się wywalił; L1/L2 dalej brały stare LLM cache hits mimo `--force` (force omija tylko artifact cache, nie LLM cache).

### Fixes

| Plik | Zmiana |
|------|--------|
| `src/pipeline/steps/topic-index.js` | sanitize empty embed inputs; fallback scene/topic text; skip `ai_generated` z B-roll |
| `src/agents/openai-client.js` | `embedTexts` nigdy nie wysyła pustych stringów |
| `src/agents/summarizer.js` | L2 `cacheKey=segmentId`; pomijaj `ai_generated` w L1/L2 |

## Hotfix: direct schema reject (audioOutSec=0)

LLM ustawił short `ai_hook` z `audioPolicy: "mute"` i `audioOutSec: 0` → Zod `positive()` fail.

Fix w `sanitizeDirectorDraft` / `ensureTimelineAudioPolicies`:
- ai_hook + mute → `from_next`
- `audioOutSec <= audioInSec` → span z video
- sceneId === clipId → `${clipId}_scene001`

## Next steps

```bash
# Wznów direct z cache (sanitize naprawi odrzucony draft):
node src/cli.js run --batch-id 51cd206d --from-step direct --to-step review --reuse-llm-cache
node src/cli.js render --batch-id 51cd206d --force --render-profile production
```
