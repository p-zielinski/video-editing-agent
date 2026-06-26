import { z } from "zod";
import { PublishVoiceSchema } from "../editorial/publish-voice.js";

export const ThumbnailSourceRefSchema = z.object({
  clipId: z.string(),
  sceneId: z.string(),
  timestampSec: z.number().nonnegative(),
});

export const ThumbnailStyleSchema = z.enum([
  "frame_only",
  "frame_plus_text",
  "frame_text_accent",
]);

export const ThumbnailStrategySchema = z.enum([
  "safe",
  "controlled",
  "risk",
]);

export const ThumbnailVariantSchema = z.object({
  variantId: z.string(),
  strategy: ThumbnailStrategySchema,
  sourceRef: ThumbnailSourceRefSchema,
  headline: z.string().max(80),
  titleVariant: z.string().max(120),
  descriptionVariant: z.string().max(500).optional(),
  style: ThumbnailStyleSchema,
  rationale: z.string(),
  renderedPath: z.string().optional(),
});

export const ThumbnailOutputPlanSchema = z.object({
  outputId: z.string(),
  format: z.enum(["16:9", "9:16"]),
  variants: z.array(ThumbnailVariantSchema).length(3),
});

export const ThumbnailPlanSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  publishVoice: PublishVoiceSchema.optional(),
  outputs: z.array(ThumbnailOutputPlanSchema).min(1),
});

export const ThumbnailIssueSchema = z.object({
  severity: z.enum(["error", "warning", "suggestion"]),
  code: z.string(),
  message: z.string(),
  outputId: z.string().optional(),
  variantId: z.string().optional(),
});

export const ThumbnailReviewSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  approved: z.boolean(),
  issues: z.array(ThumbnailIssueSchema).default([]),
  suggestions: z.array(z.string()).default([]),
  summary: z.string().optional(),
  revisedVariants: z.array(
    ThumbnailVariantSchema.extend({
      outputId: z.string(),
    }),
  ).optional(),
});
