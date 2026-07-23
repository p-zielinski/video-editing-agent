import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatJson, chatJsonMultimodal, resolveAgentModels } from "./openai-client.js";
import { classifyModelPool, createDailyQuotaTracker } from "../lib/openai-daily-usage.js";
import { executeRoutedChatJsonMultimodal, resolveRolePolicy } from "./openai-model-router.js";
import { writeLlmResponseCache } from "../lib/llm-response-cache.js";

function createJsonRetryMockClient(validPayload) {
  let callCount = 0;
  const usageEvents = [];

  const client = {
    chat: {
      completions: {
        create: async (options) => {
          callCount += 1;
          const isRetry = options.messages?.some(
            (message) => message.role === "assistant",
          );

          if (!isRetry) {
            return {
              choices: [{ message: { content: "not valid json {{{" } }],
              usage: { prompt_tokens: 40, completion_tokens: 8 },
            };
          }

          return {
            choices: [{ message: { content: JSON.stringify(validPayload) } }],
            usage: { prompt_tokens: 55, completion_tokens: 10 },
          };
        },
      },
    },
    getCallCount: () => callCount,
    getUsageEvents: () => usageEvents,
  };

  return client;
}

describe("openai-client chatJson", () => {
  it("retries with repair prompt when first response is invalid JSON", async () => {
    const validPayload = { ok: true, items: [1, 2] };
    const client = createJsonRetryMockClient(validPayload);
    const usageEvents = [];

    const result = await chatJson(client, {
      model: "gpt-5.5-mini",
      system: "Return JSON",
      user: '{"task":"test"}',
      onUsage: (event) => usageEvents.push(event),
    });

    assert.deepEqual(result, validPayload);
    assert.equal(client.getCallCount(), 2);
    assert.equal(usageEvents.length, 2);
    assert.equal(usageEvents[0].usage.prompt_tokens, 40);
    assert.equal(usageEvents[1].usage.prompt_tokens, 55);
  });

  it("parses valid JSON on first attempt without retry", async () => {
    let callCount = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            callCount += 1;
            return {
              choices: [{ message: { content: JSON.stringify({ ready: true }) } }],
            };
          },
        },
      },
    };

    const result = await chatJson(client, {
      model: "gpt-5.5-mini",
      system: "Return JSON",
      user: "{}",
    });

    assert.deepEqual(result, { ready: true });
    assert.equal(callCount, 1);
  });

  it("reuses cached response when LLM_REUSE_CACHE is enabled", async () => {
    let callCount = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            callCount += 1;
            return {
              choices: [{ message: { content: JSON.stringify({ fresh: true }) } }],
            };
          },
        },
      },
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatjson-cache-"));
    const previousReuse = process.env.LLM_REUSE_CACHE;
    process.env.LLM_REUSE_CACHE = "1";

    try {
      writeLlmResponseCache({
        batchId: "batch001",
        workDir: tmpDir,
        step: "direct",
        role: "director",
        response: { cached: true },
        model: "gpt-5.5-mini",
      });

      const result = await chatJson(client, {
        model: "gpt-5.5-mini",
        system: "Return JSON",
        user: "{}",
        batchId: "batch001",
        step: "direct",
        role: "director",
        workDir: tmpDir,
      });

      assert.deepEqual(result, { cached: true });
      assert.equal(callCount, 0);
    } finally {
      if (previousReuse === undefined) {
        delete process.env.LLM_REUSE_CACHE;
      } else {
        process.env.LLM_REUSE_CACHE = previousReuse;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("chatJsonMultimodal sends image_url userContent and parses JSON", async () => {
    let captured = null;
    const client = {
      chat: {
        completions: {
          create: async (request) => {
            captured = request;
            return {
              choices: [{ message: { content: JSON.stringify({ summary: "mountain view" }) } }],
              usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            };
          },
        },
      },
    };

    const result = await chatJsonMultimodal(client, {
      model: "gpt-4o-mini",
      system: "Return JSON",
      userContent: [
        { type: "text", text: "Describe the clip" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc", detail: "low" } },
      ],
    });

    assert.deepEqual(result, { summary: "mountain view" });
    assert.equal(captured.messages[1].content[1].type, "image_url");
    assert.equal(classifyModelPool("gpt-4o-mini"), "mini");
  });
});

describe("agent model routing", () => {
  it("uses quality-first defaults at global decisions and efficient local models", () => {
    const models = resolveAgentModels({});

    assert.equal(models.summarizerL1, "gpt-5.4-nano");
    assert.equal(models.summarizerL2, "gpt-5.4-mini");
    assert.equal(models.summarizerL3, "gpt-5.4");
    assert.equal(models.director, "gpt-5.4");
    assert.equal(models.superDirector, "gpt-5.4");
    assert.equal(models.segmentDirector, "gpt-5.4-mini");
    assert.equal(models.directorDrillDown, "gpt-5.4-mini");
    assert.equal(models.critic, "gpt-5.4-mini");
    assert.equal(models.fixer, "gpt-5.4-mini");
    assert.equal(models.fixerEscalation, "gpt-5.4");
    assert.equal(models.twelvelabsShort, "gpt-5.4-mini");
  });

  it("supports independent per-role model overrides", () => {
    const models = resolveAgentModels({
      OPENAI_MODEL_NANO: "nano-custom",
      OPENAI_MODEL_MINI: "mini-custom",
      OPENAI_MODEL_FLAGSHIP: "flagship-custom",
      OPENAI_MODEL_SUMMARIZER_L3: "l3-custom",
      OPENAI_MODEL_SUPER_DIRECTOR: "super-custom",
      OPENAI_MODEL_SEGMENT_DIRECTOR: "segment-custom",
      OPENAI_MODEL_DIRECTOR_DRILLDOWN: "drill-custom",
      OPENAI_MODEL_FIXER: "fixer-custom",
      OPENAI_MODEL_FIXER_ESCALATION: "fixer-escalation-custom",
      OPENAI_MODEL_TWELVELABS_SHORT: "gpt-4o-mini",
    });

    assert.equal(models.summarizerL1, "nano-custom");
    assert.equal(models.summarizerL2, "mini-custom");
    assert.equal(models.summarizerL3, "l3-custom");
    assert.equal(models.director, "flagship-custom");
    assert.equal(models.superDirector, "super-custom");
    assert.equal(models.segmentDirector, "segment-custom");
    assert.equal(models.directorDrillDown, "drill-custom");
    assert.equal(models.fixer, "fixer-custom");
    assert.equal(models.fixerEscalation, "fixer-escalation-custom");
    assert.equal(models.twelvelabsShort, "gpt-4o-mini");
  });

  it("twelvelabsShort role policy stays on mini tier", () => {
    assert.deepEqual(resolveRolePolicy("twelvelabsShort", {}).tiers, ["mini"]);
  });

  it("executeRoutedChatJsonMultimodal reserves and commits mini pool usage", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-mm-"));
    try {
      const quotaTracker = createDailyQuotaTracker({
        usageDir: tempDir,
        timezone: "UTC",
        batchId: "batch01",
        limits: { premium: 250000, mini: 2500000 },
      });

      const client = {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
              usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
            }),
          },
        },
      };

      const result = await executeRoutedChatJsonMultimodal(client, {
        role: "twelvelabsShort",
        model: "gpt-4o-mini",
        system: "Return JSON",
        userContent: [
          { type: "text", text: "clip" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,x", detail: "low" } },
        ],
        quotaTracker,
        batchId: "batch01",
        step: "twelvelabs",
        env: { OPENAI_QUOTA_TRACKING: "1" },
      });

      assert.deepEqual(result, { ok: true });
      const snap = quotaTracker.snapshot();
      assert.ok(snap.pools.mini.usedTokens >= 60);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
