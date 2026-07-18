import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyOpenAIError,
  executeRoutedChatJson,
  isModelDowngradeEnabled,
  resolveModelCandidates,
  resolveRolePolicy,
  resolveTierModel,
} from "./openai-model-router.js";
import { createDailyQuotaTracker } from "../lib/openai-daily-usage.js";

describe("openai-model-router", () => {
  it("resolveRolePolicy returns balanced chains per role", () => {
    const policy = resolveRolePolicy("director", {});
    assert.deepEqual(policy.tiers, ["flagship", "mini"]);
    assert.deepEqual(resolveRolePolicy("fixerEscalation", {}).tiers, ["flagship"]);
  });

  it("resolveModelCandidates skips exhausted premium pool", () => {
    const candidates = resolveModelCandidates({
      role: "director",
      env: {},
      quotaSnapshot: {
        pools: {
          premium: { exhausted: true },
          mini: { exhausted: false },
        },
      },
    });
    assert.deepEqual(candidates, ["gpt-5.4-mini"]);
  });

  it("resolveTierModel reads env on each call", () => {
    const first = resolveTierModel("flagship", { OPENAI_MODEL_FLAGSHIP: "flagship-a" });
    const second = resolveTierModel("flagship", { OPENAI_MODEL_FLAGSHIP: "flagship-b" });
    assert.equal(first, "flagship-a");
    assert.equal(second, "flagship-b");
  });

  it("classifyOpenAIError distinguishes rate limit from quota exhaustion", () => {
    assert.equal(classifyOpenAIError({ status: 429, code: "rate_limit_exceeded" }).kind, "rate_limit");
    assert.equal(classifyOpenAIError({ status: 429, code: "insufficient_quota" }).kind, "quota_exhausted");
    assert.equal(classifyOpenAIError({ status: 404, message: "does not exist" }).kind, "model_unavailable");
    assert.equal(classifyOpenAIError({ status: 500 }).kind, "retryable");
  });

  it("executeRoutedChatJson downgrades director from premium to mini when premium exhausted", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-router-"));
    try {
      const quotaTracker = createDailyQuotaTracker({
        usageDir: tempDir,
        timezone: "UTC",
        batchId: "batch01",
        limits: { premium: 100, mini: 2500000 },
      });
      quotaTracker.markPoolExhausted({ pool: "premium", reason: "test" });

      const modelsUsed = [];
      const client = {
        chat: {
          completions: {
            create: async (request) => {
              modelsUsed.push(request.model);
              return {
                choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
                usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
              };
            },
          },
        },
      };

      const result = await executeRoutedChatJson(client, {
        role: "director",
        system: "Return JSON",
        user: "{}",
        quotaTracker,
        batchId: "batch01",
        step: "direct",
        env: {
          OPENAI_MODEL_DOWNGRADE_ENABLED: "1",
          OPENAI_QUOTA_TRACKING: "1",
        },
      });

      assert.deepEqual(result, { ok: true });
      assert.deepEqual(modelsUsed, ["gpt-5.4-mini"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("executeRoutedChatJson does not downgrade fixerEscalation", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-router-"));
    try {
      const quotaTracker = createDailyQuotaTracker({
        usageDir: tempDir,
        timezone: "UTC",
        batchId: "batch01",
        limits: { premium: 100, mini: 10000 },
      });
      quotaTracker.markPoolExhausted({ pool: "premium", reason: "test" });

      const client = {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          },
        },
      };

      await assert.rejects(
        () => executeRoutedChatJson(client, {
          role: "fixerEscalation",
          system: "Return JSON",
          user: "{}",
          quotaTracker,
          batchId: "batch01",
          step: "fixer_escalation",
          env: {
            OPENAI_MODEL_DOWNGRADE_ENABLED: "1",
            OPENAI_QUOTA_TRACKING: "1",
          },
        }),
        /premium_quota_required/i,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("executeRoutedChatJson retries same model on rate limit", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-router-"));
    try {
      const quotaTracker = createDailyQuotaTracker({
        usageDir: tempDir,
        timezone: "UTC",
        batchId: "batch01",
      });
      let attempts = 0;
      const client = {
        chat: {
          completions: {
            create: async () => {
              attempts += 1;
              if (attempts === 1) {
                const error = new Error("Rate limit");
                error.status = 429;
                error.code = "rate_limit_exceeded";
                throw error;
              }
              return {
                choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
              };
            },
          },
        },
      };

      const result = await executeRoutedChatJson(client, {
        role: "critic",
        system: "Return JSON",
        user: "{}",
        quotaTracker,
        batchId: "batch01",
        step: "critic",
        env: {
          OPENAI_MODEL_DOWNGRADE_ENABLED: "1",
          OPENAI_QUOTA_TRACKING: "1",
          OPENAI_ROUTER_MAX_RETRIES: "2",
        },
      });

      assert.deepEqual(result, { ok: true });
      assert.equal(attempts, 2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("isModelDowngradeEnabled respects env flag", () => {
    assert.equal(isModelDowngradeEnabled({ OPENAI_MODEL_DOWNGRADE_ENABLED: "1" }), true);
    assert.equal(isModelDowngradeEnabled({}), false);
  });
});
