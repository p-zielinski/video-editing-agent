/**
 * TwelveLabs REST client (v1.3 tasks + analyze API).
 * Live indexing requires TWELVELABS_API_KEY and TWELVELABS_INDEX_ID.
 */

const API_BASE = "https://api.twelvelabs.io/v1.3";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 120;

const SEARCH_QUERIES = [
  { query: "most visually interesting moments, camera movement, and reactions", options: ["visual"] },
  { query: "key dialogue, emotional beats, and spoken highlights", options: ["conversation"] },
  { query: "scene changes, location transitions, and establishing shots", options: ["visual", "conversation"] },
];

const EDITORIAL_ANALYZE_PROMPT = `Analyze this video clip for a professional vlog/YouTube editor.
Identify how the clip should be used in an edit: narrative role, mood, chapter structure, and timestamped highlights.
Prefer concrete, actionable descriptions (what is visible, what is said, why it matters for retention).
Chapters must cover the full clip timeline without gaps. Highlights should be 3-12 seconds each.`;

export const EDITORIAL_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
    mood: { type: "string" },
    narrativeRole: { type: "string" },
    editingHints: { type: "array", items: { type: "string" } },
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chapter_title: { type: "string" },
          chapter_summary: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
        },
        required: ["chapter_title", "start", "end"],
      },
    },
    highlights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          editUse: { type: "string" },
        },
        required: ["description", "start", "end"],
      },
    },
  },
  required: ["summary", "chapters", "highlights"],
};

function authHeaders(apiKey) {
  return { "x-api-key": apiKey };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`TwelveLabs: nieprawidłowa odpowiedź JSON (${response.status})`);
  }
}

async function tlFetch(apiKey, path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...authHeaders(apiKey),
      ...(options.headers ?? {}),
    },
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    const detail = body.message ?? body.error ?? JSON.stringify(body);
    throw new Error(`TwelveLabs ${response.status}: ${detail}`);
  }
  return body;
}

export async function resolveTwelveLabsIndexId(apiKey, indexId) {
  if (indexId) {
    return indexId;
  }
  const envIndex = process.env.TWELVELABS_INDEX_ID;
  if (envIndex) {
    return envIndex;
  }
  const indexes = await tlFetch(apiKey, "/indexes");
  const first = indexes.data?.[0]?._id ?? indexes.data?.[0]?.id;
  if (!first) {
    throw new Error("TwelveLabs: brak index_id — ustaw TWELVELABS_INDEX_ID lub utwórz index w konsoli");
  }
  return first;
}

export async function createIndexingTask({ apiKey, indexId, sourcePath, clipId }) {
  const resolvedIndexId = await resolveTwelveLabsIndexId(apiKey, indexId);
  const form = new FormData();
  form.append("index_id", resolvedIndexId);
  const fileBuffer = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath));
  const blob = new Blob([fileBuffer]);
  form.append("video_file", blob, `${clipId}.mp4`);

  const response = await fetch(`${API_BASE}/tasks`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    const detail = body.message ?? body.error ?? JSON.stringify(body);
    throw new Error(`TwelveLabs upload ${response.status}: ${detail}`);
  }
  return body._id ?? body.id ?? body.task_id;
}

export async function pollIndexingTask(apiKey, taskId) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const task = await tlFetch(apiKey, `/tasks/${taskId}`);
    const status = task.status ?? task._source?.status;
    if (status === "ready" || status === "Ready") {
      return task;
    }
    if (status === "failed" || status === "Failed") {
      throw new Error(`TwelveLabs indexing failed: ${task.error ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`TwelveLabs indexing timeout after ${MAX_POLL_ATTEMPTS} polls`);
}

export function parseAnalyzeData(raw) {
  if (!raw) {
    return null;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { summary: raw };
    }
  }
  return null;
}

function normalizeMoment(entry, { source = "search" } = {}) {
  return {
    startSec: entry.start ?? entry.start_sec ?? entry.startSec ?? entry.start_time ?? 0,
    endSec: entry.end ?? entry.end_sec ?? entry.endSec ?? entry.end_time ?? entry.start ?? 0,
    description: entry.description ?? entry.text ?? "",
    summary: entry.summary ?? undefined,
    tags: entry.tags ?? [],
    editUse: entry.editUse ?? entry.edit_use ?? undefined,
    source,
  };
}

function normalizeChapter(entry) {
  return {
    startSec: entry.start ?? entry.start_sec ?? entry.startSec ?? 0,
    endSec: entry.end ?? entry.end_sec ?? entry.endSec ?? entry.start ?? 0,
    title: entry.chapter_title ?? entry.title ?? entry.summary ?? "",
    summary: entry.chapter_summary ?? entry.summary ?? undefined,
  };
}

function momentsOverlap(a, b, toleranceSec = 2) {
  const aStart = a.startSec ?? 0;
  const bStart = b.startSec ?? 0;
  return Math.abs(aStart - bStart) <= toleranceSec;
}

export function mergeAndDedupeMoments(momentLists) {
  const merged = [];
  for (const list of momentLists) {
    for (const moment of list ?? []) {
      if (!moment?.description && !moment?.summary) {
        continue;
      }
      const duplicate = merged.find((existing) => momentsOverlap(existing, moment));
      if (duplicate) {
        if ((moment.description?.length ?? 0) > (duplicate.description?.length ?? 0)) {
          duplicate.description = moment.description;
        }
        duplicate.summary = duplicate.summary ?? moment.summary;
        duplicate.editUse = duplicate.editUse ?? moment.editUse;
        duplicate.tags = [...new Set([...(duplicate.tags ?? []), ...(moment.tags ?? [])])];
        duplicate.source = duplicate.source ?? moment.source;
      } else {
        merged.push({ ...moment });
      }
    }
  }
  return merged.sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
}

function preferChapters(primary, fallback) {
  const primaryHasSummary = (primary ?? []).some((chapter) => chapter.summary);
  if ((primary ?? []).length > 0 && primaryHasSummary) {
    return primary;
  }
  if ((fallback ?? []).length > (primary ?? []).length) {
    return fallback;
  }
  return (primary ?? []).length > 0 ? primary : (fallback ?? []);
}

async function fetchGist(apiKey, indexId, videoId) {
  try {
    const gist = await tlFetch(apiKey, `/indexes/${indexId}/videos/${videoId}/gist`);
    return {
      title: gist.title ?? undefined,
      topics: gist.topics ?? [],
      hashtags: gist.hashtags ?? [],
      clipSummary: gist.title ?? gist.summary ?? gist.topics?.join(", "),
    };
  } catch {
    try {
      const gist = await tlFetch(apiKey, "/gist", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
        body: JSON.stringify({
          video_id: videoId,
          types: ["title", "topic", "hashtag"],
        }),
      });
      return {
        title: gist.title ?? undefined,
        topics: gist.topics ?? [],
        hashtags: gist.hashtags ?? [],
        clipSummary: gist.title ?? gist.topics?.join(", "),
      };
    } catch {
      return null;
    }
  }
}

async function searchMoments(apiKey, indexId, videoId, { query, options }) {
  const search = await tlFetch(apiKey, "/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify({
      index_id: indexId,
      query,
      filter: { id: [videoId] },
      options,
    }),
  });
  return (search.data ?? []).map((entry) => normalizeMoment(entry, { source: "search" }));
}

async function fetchSearchMoments(apiKey, indexId, videoId) {
  const results = await Promise.all(
    SEARCH_QUERIES.map(async ({ query, options }) => {
      try {
        return await searchMoments(apiKey, indexId, videoId, { query, options });
      } catch {
        return [];
      }
    }),
  );
  return mergeAndDedupeMoments(results);
}

export async function fetchEditorialAnalysis(apiKey, videoId) {
  const response = await tlFetch(apiKey, "/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify({
      video_id: videoId,
      prompt: EDITORIAL_ANALYZE_PROMPT,
      temperature: 0.2,
      stream: false,
      max_tokens: 4096,
      response_format: {
        type: "json_schema",
        json_schema: EDITORIAL_ANALYSIS_SCHEMA,
      },
    }),
  });

  const parsed = parseAnalyzeData(response.data);
  if (!parsed) {
    return null;
  }

  return {
    title: parsed.title ?? undefined,
    summary: parsed.summary ?? undefined,
    topics: parsed.topics ?? [],
    mood: parsed.mood ?? undefined,
    narrativeRole: parsed.narrativeRole ?? undefined,
    editingHints: parsed.editingHints ?? [],
    chapters: (parsed.chapters ?? []).map(normalizeChapter),
    highlights: (parsed.highlights ?? []).map((entry) => normalizeMoment(entry, { source: "analyze" })),
  };
}

export async function fetchVideoInsights(apiKey, indexId, videoId) {
  const resolvedIndexId = await resolveTwelveLabsIndexId(apiKey, indexId);
  let chapters = [];
  let moments = [];
  let clipSummary;
  let gist;
  let editorial;

  gist = await fetchGist(apiKey, resolvedIndexId, videoId);
  if (gist?.clipSummary) {
    clipSummary = gist.clipSummary;
  }

  try {
    moments = await fetchSearchMoments(apiKey, resolvedIndexId, videoId);
  } catch {
    // search may be unavailable on all plans
  }

  try {
    editorial = await fetchEditorialAnalysis(apiKey, videoId);
  } catch {
    // analyze optional (plan/model limits)
  }

  try {
    const video = await tlFetch(apiKey, `/indexes/${resolvedIndexId}/videos/${videoId}`);
    const metadataChapters = (video.chapters ?? video.system_metadata?.chapters ?? []).map(normalizeChapter);
    chapters = preferChapters(editorial?.chapters, metadataChapters);
    if (!clipSummary) {
      clipSummary = video.title ?? video.metadata?.filename;
    }
  } catch {
    chapters = editorial?.chapters ?? [];
  }

  if (editorial?.highlights?.length) {
    moments = mergeAndDedupeMoments([moments, editorial.highlights]);
  }

  if (!clipSummary) {
    clipSummary = editorial?.title ?? editorial?.summary;
  }

  return {
    moments,
    chapters,
    clipSummary,
    gist,
    editorial,
  };
}

export async function refreshVideoInsightsFromAsset({ apiKey, indexId, videoId }) {
  const insights = await fetchVideoInsights(apiKey, indexId, videoId);
  return {
    twelveLabsAssetId: videoId,
    indexingStatus: "indexed",
    ...insights,
  };
}

export async function indexVideoFromPath({
  apiKey,
  indexId,
  sourcePath,
  clipId,
  existingVideoId,
  skipUpload,
}) {
  if (skipUpload && existingVideoId) {
    return refreshVideoInsightsFromAsset({ apiKey, indexId, videoId: existingVideoId });
  }

  const taskId = await createIndexingTask({ apiKey, indexId, sourcePath, clipId });
  const task = await pollIndexingTask(apiKey, taskId);
  const videoId = task.video_id ?? task._source?.video_id;
  if (!videoId) {
    throw new Error("TwelveLabs: brak video_id po indeksacji");
  }
  const insights = await fetchVideoInsights(apiKey, indexId, videoId);
  return {
    twelveLabsAssetId: videoId,
    indexingStatus: "indexed",
    taskId,
    ...insights,
  };
}

/**
 * Summarize TwelveLabs artifacts for director brief (per clip).
 */
export function summarizeTwelveLabsForBrief(twelveLabsByClip, {
  maxMomentsPerClip = 12,
  maxChaptersPerClip = 8,
  maxEditingHints = 6,
} = {}) {
  const summary = [];
  for (const [clipId, payload] of Object.entries(twelveLabsByClip ?? {})) {
    if (!payload || payload.indexingStatus === "stub") {
      continue;
    }
    const editorial = payload.editorial ?? {};
    summary.push({
      clipId,
      clipSummary: payload.clipSummary ?? editorial.summary ?? null,
      title: editorial.title ?? payload.gist?.title ?? null,
      topics: editorial.topics?.length
        ? editorial.topics
        : (payload.gist?.topics ?? []),
      mood: editorial.mood ?? null,
      narrativeRole: editorial.narrativeRole ?? null,
      editingHints: (editorial.editingHints ?? []).slice(0, maxEditingHints),
      chapters: (payload.chapters ?? []).slice(0, maxChaptersPerClip),
      moments: (payload.moments ?? []).slice(0, maxMomentsPerClip),
    });
  }
  return summary.length > 0 ? summary : undefined;
}
