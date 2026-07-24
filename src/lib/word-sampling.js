import { DIRECTOR_BRIEF_CAPS } from "../editorial/brief-caps.js";

/**
 * Sample words across a long scene using time-distributed windows
 * (beginning, middle, end, and evenly spaced chunks for very long scenes).
 */
export function sampleWordsAcrossScene(words, maxWords, caps = DIRECTOR_BRIEF_CAPS) {
  if (!Array.isArray(words) || words.length === 0) {
    return [];
  }
  if (words.length <= maxWords) {
    return words;
  }

  const overcapRatio = caps.longSceneWordOvercapRatio ?? 2;
  if (words.length <= maxWords * overcapRatio) {
    return words.slice(0, maxWords);
  }

  const budgetMultiplier = caps.longSceneSampleBudgetMultiplier ?? 3;
  const windowWords = caps.longSceneWindowWords ?? 20;
  const minWindows = caps.longSceneMinWindows ?? 3;
  const maxWindows = caps.longSceneMaxWindows ?? 8;
  const windowIntervalSec = caps.longSceneWindowIntervalSec ?? 180;

  const budget = Math.min(
    words.length,
    Math.max(maxWords, Math.round(maxWords * budgetMultiplier)),
  );

  const sceneStart = words[0].start;
  const sceneEnd = words.at(-1).end;
  const duration = sceneEnd - sceneStart;
  if (!Number.isFinite(duration) || duration <= 0) {
    return words.slice(0, budget);
  }

  const durationWindows = Math.ceil(duration / windowIntervalSec);
  const numWindows = Math.min(
    maxWindows,
    Math.max(minWindows, durationWindows),
  );
  const wordsPerWindow = Math.min(windowWords, Math.ceil(budget / numWindows));

  const sampled = [];
  const usedIndices = new Set();

  for (let w = 0; w < numWindows; w += 1) {
    const anchorTime = sceneStart + (duration * w) / Math.max(1, numWindows - 1);
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < words.length; i += 1) {
      const dist = Math.abs(words[i].start - anchorTime);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    const startIdx = Math.max(0, bestIdx - Math.floor(wordsPerWindow / 2));
    const endIdx = Math.min(words.length, startIdx + wordsPerWindow);
    for (let i = startIdx; i < endIdx && sampled.length < budget; i += 1) {
      if (!usedIndices.has(i)) {
        usedIndices.add(i);
        sampled.push(words[i]);
      }
    }
  }

  sampled.sort((a, b) => a.start - b.start);
  return sampled.slice(0, budget);
}
