import { z } from "zod";
import { PIPELINE_STEPS } from "../pipeline/work-paths.js";

export const ClipOutcomeStatusSchema = z.enum(["succeeded", "failed", "skipped", "degraded"]);

export const ClipOutcomeSchema = z.object({
  status: ClipOutcomeStatusSchema,
  errorCode: z.string().optional(),
  message: z.string().optional(),
});

export const StepExecutionErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  cause: z.string().optional(),
});

export const StepExecutionSchema = z.object({
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped", "degraded"]),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: StepExecutionErrorSchema.optional(),
  clipOutcomes: z.record(z.string(), ClipOutcomeSchema).optional(),
});

export const ExecutionStateSchema = z.object({
  version: z.literal("1.0"),
  pipelineRunId: z.string(),
  batchId: z.string(),
  status: z.enum(["running", "succeeded", "failed", "degraded"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  currentStep: z.enum(PIPELINE_STEPS).nullable().optional(),
  steps: z.record(z.enum(PIPELINE_STEPS), StepExecutionSchema).default({}),
});
