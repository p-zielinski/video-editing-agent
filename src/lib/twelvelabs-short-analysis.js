import fs from "node:fs";
import path from "node:path";
import { extractFrameAt } from "./ffmpeg.js";
import { chatJsonMultimodal, createOpenAIClient, MODELS } from "../agents/openai-client.js";
import { buildAgentChatContext } from "./gpt-usage-log.js";
import { ARTIFACTS, readJson } from "../pipeline/work-paths.js";
import { EDITORIAL_ANALYSIS_SCHEMA } from "./twelvelabs-client.js";

const SHORT_SYSTEM_PROMPT = `You analyze a short video clip for a professional vlog/YouTube editor.
Given still frames (and optional transcript), return JSON matching the editorial schema:
summary, chapters (one chapter covering 0→duration), highlights (1–2 short moments),
mood, narrativeRole, editingHints, topics, title.
Be concrete and actionable. Timestamps must be within [0, durationSec].`;

/**
 * @param {number} durationSec
 * @returns {number[]}
 */
export function planShortClipFrameTimestamps(durationSec) {
  const duration = Math.max(0, durationSec);
  if (duration < 0.05) {
    return [0];
  }
  if (duration < 2) {
    return [Math.min(duration * 0.5, Math.max(0, duration - 0.05))];
  }
  const mid = duration * 0.5;
  const start = Math.min(0.1, duration * 0.15);
  const end = Math.max(start, duration - 0.1);
  return [...new Set([start, mid, end].map((t) => Math.round(t * 100) / 100))];
}

function frameToDataUrl(framePath) {
  const buf = fs.readFileSync(framePath);
  const ext = path.extname(framePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function loadTranscriptSnippet(workDir, clipId) {
  const wordsPath = path.join(workDir, ARTIFACTS.words(clipId));
  if (!fs.existsSync(wordsPath)) {
    return null;
  }
  try {
    const words = readJson(wordsPath);
    const text = (words.words ?? [])
      .map((w) => w.word ?? w.text ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

function normalizeShortEditorial(parsed, durationSec) {
  const chapters = (parsed.chapters ?? []).map((entry) => ({
    startSec: entry.start ?? entry.startSec ?? 0,
    endSec: entry.end ?? entry.endSec ?? durationSec,
    title: entry.chapter_title ?? entry.title ?? entry.summary ?? "Clip",
    summary: entry.chapter_summary ?? entry.summary ?? undefined,
  }));
  const highlights = (parsed.highlights ?? []).map((entry) => ({
    startSec: entry.start ?? entry.startSec ?? 0,
    endSec: entry.end ?? entry.endSec ?? Math.min(durationSec, (entry.start ?? 0) + 1),
    description: entry.description ?? entry.text ?? "",
    editUse: entry.editUse ?? entry.edit_use ?? undefined,
    source: "frame_analysis",
  }));

  if (chapters.length === 0) {
    chapters.push({
      startSec: 0,
      endSec: durationSec,
      title: parsed.title ?? "Clip",
      summary: parsed.summary,
    });
  }
  if (highlights.length === 0 && parsed.summary) {
    highlights.push({
      startSec: 0,
      endSec: Math.min(durationSec, Math.max(0.5, durationSec)),
      description: parsed.summary,
      source: "frame_analysis",
    });
  }

  return {
    title: parsed.title,
    summary: parsed.summary,
    topics: parsed.topics ?? [],
    mood: parsed.mood,
    narrativeRole: parsed.narrativeRole,
    editingHints: parsed.editingHints ?? [],
    chapters,
    highlights,
  };
}

/**
 * Analyze a short clip (&lt;4s) via GPT vision frames → Twelvelabs-shaped payload fields.
 */
export async function analyzeShortClipWithGpt({
  workDir,
  clip,
  sourcePath,
  durationSec,
  openaiApiKey,
  dailyQuotaTracker = null,
  gptUsageTracker = null,
  batchId = null,
  extractFrameAtFn = extractFrameAt,
  chatJsonMultimodalFn = chatJsonMultimodal,
  createClientFn = createOpenAIClient,
}) {
  if (!openaiApiKey) {
    throw new Error("TwelveLabs short-clip analysis requires OPENAI_API_KEY");
  }

  const timestamps = planShortClipFrameTimestamps(durationSec);
  const framesDir = path.join(workDir, "twelvelabs-frames", clip.clipId);
  fs.mkdirSync(framesDir, { recursive: true });

  const framePaths = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const framePath = path.join(framesDir, `frame-${String(i).padStart(2, "0")}.jpg`);
    await extractFrameAtFn(sourcePath, timestamps[i], framePath);
    framePaths.push(framePath);
  }

  const transcript = loadTranscriptSnippet(workDir, clip.clipId);
  const textPayload = {
    clipId: clip.clipId,
    durationSec,
    transcript: transcript ?? null,
    responseSchema: EDITORIAL_ANALYSIS_SCHEMA,
  };

  const userContent = [
    { type: "text", text: JSON.stringify(textPayload) },
    ...framePaths.map((framePath) => ({
      type: "image_url",
      image_url: { url: frameToDataUrl(framePath), detail: "low" },
    })),
  ];

  const client = createClientFn(openaiApiKey);
  const chatContext = buildAgentChatContext({
    gptUsageTracker,
    dailyQuotaTracker,
    batchId,
    step: "twelvelabs",
  });

  const parsed = await chatJsonMultimodalFn(client, {
    role: "twelvelabsShort",
    model: MODELS.twelvelabsShort,
    system: SHORT_SYSTEM_PROMPT,
    userContent,
    temperature: 0.2,
    ...chatContext,
  });

  const editorial = normalizeShortEditorial(parsed, durationSec);
  return {
    indexingStatus: "frame_analysis",
    clipSummary: editorial.summary ?? editorial.title,
    chapters: editorial.chapters,
    moments: editorial.highlights,
    editorial: {
      title: editorial.title,
      summary: editorial.summary,
      topics: editorial.topics,
      mood: editorial.mood,
      narrativeRole: editorial.narrativeRole,
      editingHints: editorial.editingHints,
      chapters: editorial.chapters,
      highlights: editorial.highlights,
    },
  };
}
