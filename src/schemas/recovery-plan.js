import { z } from "zod";
import { PIPELINE_STEPS } from "../pipeline/work-paths.js";

export const RecoveryFailureScopeSchema = z.object({
  clipId: z.string().optional(),
  outputId: z.string().optional(),
  segmentId: z.string().optional(),
  pass: z.string().optional(),
}).optional();

export const RecoveryFailureSchema = z.object({
  code: z.string(),
  step: z.enum([...PIPELINE_STEPS, "render"]),
  scope: RecoveryFailureScopeSchema,
  message: z.string(),
  cause: z.string().optional(),
  prerequisites: z.array(z.string()).default([]),
  recoveryCommand: z.string(),
  artifactsToInvalidate: z.array(z.string()).optional(),
  forceRequired: z.boolean().optional(),
});

export const RecoveryPlanSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  pipelineRunId: z.string(),
  status: z.enum(["action_required", "blocked", "resolved"]),
  failedStep: z.enum([...PIPELINE_STEPS, "render"]).nullable(),
  createdAt: z.string(),
  failures: z.array(RecoveryFailureSchema),
  recommendedCommand: z.string(),
});
