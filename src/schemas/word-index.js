import { z } from "zod";

export const WordEntrySchema = z.object({
  wordId: z.string(),
  word: z.string(),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  isFiller: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  normalizedWord: z.string().optional(),
  isProfanity: z.boolean().optional(),
  displayWord: z.string().optional(),
  safetyClass: z.enum([
    "profanity",
    "sensitive",
    "protected_identity",
    "hateful_attack",
  ]).optional(),
  safetyAction: z.enum(["allow", "review", "bleep", "mute", "cut", "mask"]).optional(),
  safetyReason: z.string().optional(),
  safetyConfidence: z.number().min(0).max(1).optional(),
});

export const WordIndexSchema = z.object({
  version: z.enum(["1.0", "1.1"]),
  clipId: z.string(),
  words: z.array(WordEntrySchema),
  durationSec: z.number().positive(),
});

export function assignWordIds(words, clipId) {
  return words.map((entry, index) => ({
    wordId: `${clipId}_w${String(index).padStart(5, "0")}`,
    word: entry.word,
    start: entry.start,
    end: entry.end,
    ...(entry.isFiller !== undefined && { isFiller: entry.isFiller }),
    ...(entry.confidence !== undefined && { confidence: entry.confidence }),
    ...(entry.normalizedWord !== undefined && { normalizedWord: entry.normalizedWord }),
    ...(entry.isProfanity !== undefined && { isProfanity: entry.isProfanity }),
    ...(entry.displayWord !== undefined && { displayWord: entry.displayWord }),
    ...(entry.safetyClass !== undefined && { safetyClass: entry.safetyClass }),
    ...(entry.safetyAction !== undefined && { safetyAction: entry.safetyAction }),
    ...(entry.safetyReason !== undefined && { safetyReason: entry.safetyReason }),
    ...(entry.safetyConfidence !== undefined && { safetyConfidence: entry.safetyConfidence }),
  }));
}
