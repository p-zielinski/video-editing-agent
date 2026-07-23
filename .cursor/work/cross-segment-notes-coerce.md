# roleSource ai_video + LLM response cache

> Last updated: 2026-07-19
> Status: done

## Problem & goal

Batch `51cd206d` failed at `direct` because `clipRegistry[40].roleSource === "ai_video"` was missing from `RoleSourceSchema`. LLM responses were lost on Zod failures (wasted tokens).

## Progress

- [x] Added `ai_video` to `RoleSourceSchema` + JSON schema export + test
- [x] `src/lib/llm-response-cache.js` — write/read cache, `parseAgentSchema`, rejected sidecar
- [x] Integrated in `chatJson`, router, agents (super/segment/director/fixer)
- [x] CLI `--reuse-llm-cache`, recovery hints for ZodError
- [x] README + `.env.example` notes

## Verification

```bash
node --test src/schemas/edit-recipe-v2-rolesource.test.js src/lib/llm-response-cache.test.js src/agents/openai-client.test.js src/lib/recovery/classify-error.test.js
```

Resume batch:
```bash
node src/cli.js run --batch-id 51cd206d --from-step direct
# after editing llm-cache:
node src/cli.js run --batch-id 51cd206d --from-step direct --reuse-llm-cache
```
