const SPEECH_COVERAGE_RATIO = 0.3;

/**
 * V25-SPEECH-COVERAGE: aroll_primary clips that hold ≥30% of batch speech words
 * must appear on the main output timeline (videoRef or audioRef clipId).
 */
export function validateSpeechCoverage(recipe) {
  const issues = [];
  const clipRegistry = recipe.clipRegistry ?? [];
  if (clipRegistry.length === 0) {
    return issues;
  }

  const totalSpeechWords = clipRegistry.reduce(
    (sum, clip) => sum + (clip.speechWordCount ?? 0),
    0,
  );
  if (totalSpeechWords <= 0) {
    return issues;
  }

  const threshold = totalSpeechWords * SPEECH_COVERAGE_RATIO;
  const dominantClips = clipRegistry.filter(
    (clip) =>
      clip.clipRole === "aroll_primary"
      && (clip.speechWordCount ?? 0) >= threshold,
  );
  if (dominantClips.length === 0) {
    return issues;
  }

  const main = recipe.outputs?.find((output) => output.outputKind === "main")
    ?? recipe.outputs?.find((output) => output.format === "16:9")
    ?? recipe.outputs?.[0];
  if (!main?.timeline?.length) {
    for (const clip of dominantClips) {
      issues.push({
        severity: "error",
        code: "V25-SPEECH-COVERAGE",
        message: `Klip ${clip.clipId} (aroll_primary, ${clip.speechWordCount} słów ≥30% batch speech) musi pojawić się na main timeline`,
        clipId: clip.clipId,
      });
    }
    return issues;
  }

  const usedClipIds = new Set();
  for (const segment of main.timeline) {
    if (segment.videoRef?.clipId) {
      usedClipIds.add(segment.videoRef.clipId);
    }
    if (segment.audioRef?.clipId) {
      usedClipIds.add(segment.audioRef.clipId);
    }
  }

  for (const clip of dominantClips) {
    if (!usedClipIds.has(clip.clipId)) {
      const pct = Math.round(((clip.speechWordCount ?? 0) / totalSpeechWords) * 100);
      issues.push({
        severity: "error",
        code: "V25-SPEECH-COVERAGE",
        message: `Klip ${clip.clipId} (aroll_primary, ${clip.speechWordCount} słów ≈${pct}% batch speech) musi pojawić się na main timeline (videoRef lub audioRef)`,
        clipId: clip.clipId,
        outputId: main.outputId,
      });
    }
  }

  return issues;
}
