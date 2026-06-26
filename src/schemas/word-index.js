import { z } from "zod";

export const WordEntrySchema = z.object({
  wordId: z.string(),
  word: z.string(),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  isFiller: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const WordIndexSchema = z.object({
  version: z.literal("1.0"),
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
    isFiller: entry.isFiller,
    confidence: entry.confidence,
  }));
}
