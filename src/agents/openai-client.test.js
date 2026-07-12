import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chatJson, resolveAgentModels } from "./openai-client.js";

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
  });
});
