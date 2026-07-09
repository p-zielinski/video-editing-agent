import { z } from "zod";

export const PublishPackageSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  outputId: z.string(),
  format: z.enum(["16:9", "9:16"]),
  outputKind: z.enum(["main", "short"]).optional(),
  title: z.string(),
  titleVariants: z.array(z.string()).default([]),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  chapterTimestamps: z.array(z.string()).default([]),
  thumbnailPath: z.string().nullable().optional(),
  videoPath: z.string().nullable().optional(),
  shortsCaption: z.string().nullable().optional(),
});
