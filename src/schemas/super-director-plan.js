import { z } from "zod";
import { CreativityProfileSchema, NarrativeProfileSchema } from "./edit-recipe-v2.js";

export const SegmentPickSchema = z.object({
  segmentId: z.string(),
  priority: z.number().int().min(1).max(10),
  targetKeepRatio: z.number().min(0).max(1).optional(),
});

export const CrossSegmentCallbackSchema = z.object({
  callbackId: z.string(),
  setupSceneId: z.string(),
  payoffSceneId: z.string(),
  teaseText: z.string().optional(),
});

const NOTE_OBJECT_KEYS = ["note", "text", "message"];

export function coerceNoteString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => coerceNoteString(item))
      .filter((item) => item.length > 0)
      .join("; ");
  }
  if (typeof value === "object") {
    for (const key of NOTE_OBJECT_KEYS) {
      if (typeof value[key] === "string") {
        return value[key].trim();
      }
    }
    return JSON.stringify(value);
  }
  return String(value).trim();
}

function preprocessCrossSegmentNotes(value) {
  if (value === null || value === undefined) {
    return [];
  }
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => coerceNoteString(item))
    .filter((item) => item.length > 0);
}

export const SuperDirectorPlanSchema = z.object({
  segmentOrder: z.array(z.string()).default([]),
  segmentPicks: z.array(SegmentPickSchema).default([]),
  crossSegmentCallbacks: z.array(CrossSegmentCallbackSchema).default([]),
  crossSegmentNotes: z.preprocess(
    preprocessCrossSegmentNotes,
    z.array(z.string()),
  ).default([]),
  shortsSources: z.array(z.string()).default([]),
  globalTheme: z.string().optional(),
  creativityProfile: CreativityProfileSchema.optional(),
  narrativeProfile: NarrativeProfileSchema.optional(),
  excludedClips: z.array(z.string()).default([]),
});
