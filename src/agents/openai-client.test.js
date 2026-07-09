import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chatJson } from "./openai-client.js";

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
