/**
 * Parse Pixabay music track metadata from page HTML or saved snapshot.
 * Pixabay may block headless fetch (Cloudflare) — use --html with a browser save as fallback.
 */
import fs from "node:fs";
import path from "node:path";

const SECTION_ORDER = ["genre", "mood", "movement", "theme"];

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function splitPixabayTagLine(line) {
  const trimmed = decodeHtmlEntities(String(line ?? "").trim());
  if (!trimmed) {
    return [];
  }

  const anchorTags = [...trimmed.matchAll(/<a[^>]*>([^<]+)<\/a>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (anchorTags.length > 0) {
    return anchorTags;
  }

  const chipTags = [...trimmed.matchAll(/<(?:span|button|li)[^>]*>([^<]+)<\/(?:span|button|li)>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (chipTags.length > 0) {
    return chipTags;
  }

  const plain = trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const words = plain.split(" ").filter(Boolean);
  if (words.length <= 1) {
    return words;
  }

  const tags = [];
  let current = words[0];
  const joinWords = new Set(["for", "and", "the", "of", "in", "to", "on", "a"]);

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    const prev = words[i - 1];
    const shouldJoin =
      joinWords.has(word.toLowerCase())
      || (joinWords.has(prev.toLowerCase()))
      || (word[0] === word[0].toLowerCase());

    if (shouldJoin) {
      current = `${current} ${word}`;
    } else {
      tags.push(current);
      current = word;
    }
  }
  tags.push(current);
  return tags;
}

function normalizeSectionKey(key) {
  return String(key ?? "").toLowerCase().replace(/\s+/g, "");
}

function isSectionBucket(key, value) {
  const normalized = normalizeSectionKey(key);
  if (!SECTION_ORDER.includes(normalized)) {
    return false;
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function collectSectionsFromObject(node, sections = {}) {
  if (!node || typeof node !== "object") {
    return sections;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectSectionsFromObject(item, sections);
    }
    return sections;
  }

  for (const [key, value] of Object.entries(node)) {
    if (isSectionBucket(key, value)) {
      const bucket = normalizeSectionKey(key);
      if (!sections[bucket]?.length) {
        sections[bucket] = value.map((entry) => String(entry).trim()).filter(Boolean);
      }
      continue;
    }
    collectSectionsFromObject(value, sections);
  }

  return sections;
}

function parseNextData(html) {
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseLabeledSectionsFromText(text) {
  const sections = {};
  const pattern = /(?:^|\n)\s*(Genre|Mood|Movement|Theme)\s*\n\s*([\s\S]*?)(?=\n\s*(?:Genre|Mood|Movement|Theme|Free for use|Comments|Media type)\b|$)/gi;
  let match = pattern.exec(text);
  while (match) {
    const bucket = normalizeSectionKey(match[1]);
    sections[bucket] = splitPixabayTagLine(match[2].replace(/\s+/g, " "));
    match = pattern.exec(text);
  }
  return sections;
}

function parseLabeledSectionsFromHtml(html) {
  const sections = {};
  const dtPattern = /<dt[^>]*>\s*(Genre|Mood|Movement|Theme)\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let match = dtPattern.exec(html);
  while (match) {
    const bucket = normalizeSectionKey(match[1]);
    sections[bucket] = splitPixabayTagLine(match[2]);
    match = dtPattern.exec(html);
  }

  if (Object.keys(sections).length > 0) {
    return sections;
  }

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\r/g, "");

  return parseLabeledSectionsFromText(text);
}

export function extractPixabayIdFromUrl(url) {
  const match = String(url ?? "").match(/-(\d+)\/?(?:\?|#|$)/);
  return match ? match[1] : null;
}

export function extractMusicSlugFromUrl(url) {
  const match = String(url ?? "").match(/\/music\/([^/?#]+)\/?/);
  return match ? match[1] : null;
}

export function expectedMp3FileNameFromUrl(url) {
  const slug = extractMusicSlugFromUrl(url);
  return slug ? `${slug}.mp3` : null;
}

/**
 * Candidate MP3 filenames for a Pixabay music URL (slug first, then id suffix).
 * @param {string} url
 * @param {string[]} [existingFileNames]
 */
export function listMp3CandidatesForPixabayUrl(url, existingFileNames = []) {
  const candidates = [];
  const seen = new Set();

  function add(name) {
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    candidates.push(name);
  }

  const expected = expectedMp3FileNameFromUrl(url);
  if (expected) {
    add(expected);
  }

  const pixabayId = extractPixabayIdFromUrl(url);
  if (pixabayId) {
    for (const fileName of existingFileNames) {
      if (fileName.endsWith(`-${pixabayId}.mp3`) || fileName.endsWith(`_${pixabayId}.mp3`)) {
        add(fileName);
      }
    }
  }

  return candidates;
}

/**
 * Resolve an MP3 in musicDir from Pixabay URL slug or *-{id}.mp3 fallback.
 * @param {string} url
 * @param {string} musicDir
 */
export function resolveMusicFileForPixabayUrl(url, musicDir) {
  const existingFileNames = fs.existsSync(musicDir)
    ? fs.readdirSync(musicDir).filter((name) => name.toLowerCase().endsWith(".mp3"))
    : [];

  for (const fileName of listMp3CandidatesForPixabayUrl(url, existingFileNames)) {
    const filePath = path.join(musicDir, fileName);
    if (fs.existsSync(filePath)) {
      return {
        fileName,
        filePath,
        match: fileName === expectedMp3FileNameFromUrl(url) ? "slug" : "pixabay_id",
      };
    }
  }

  return null;
}

export function extractTitleFromHtml(html, url = "") {
  const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (ogMatch) {
    return ogMatch[1].split("|")[0].trim();
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    return h1Match[1].replace(/<[^>]+>/g, "").trim();
  }

  const slugMatch = String(url).match(/\/music\/([^/?#]+)-\d+\/?/);
  if (slugMatch) {
    return slugMatch[1]
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  return null;
}

/**
 * @param {string} html
 * @param {{ url?: string, title?: string }} [options]
 */
export function parsePixabayMusicPage(html, { url = "", title = null } = {}) {
  const nextData = parseNextData(html);
  const fromJson = nextData ? collectSectionsFromObject(nextData) : {};
  const fromHtml = parseLabeledSectionsFromHtml(html);

  const pixabay = {};
  for (const bucket of SECTION_ORDER) {
    const tags = fromJson[bucket]?.length ? fromJson[bucket] : fromHtml[bucket];
    if (tags?.length) {
      pixabay[bucket] = tags;
    }
  }

  const pixabayId = extractPixabayIdFromUrl(url);
  const resolvedTitle = title ?? extractTitleFromHtml(html, url);

  if (!resolvedTitle && Object.keys(pixabay).length === 0) {
    throw new Error(
      "Nie udało się sparsować metadanych Pixabay. Zapisz stronę w przeglądarce i użyj --html, albo --tags-json.",
    );
  }

  return {
    pixabayId,
    title: resolvedTitle ?? `Pixabay ${pixabayId ?? "track"}`,
    pixabay,
    sourceUrl: url || null,
  };
}

function normalizeTag(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ");
}

export function deriveMoodTags(pixabay = {}) {
  const tags = new Set();
  for (const bucket of ["mood", "genre", "movement"]) {
    for (const entry of pixabay[bucket] ?? []) {
      tags.add(normalizeTag(entry));
    }
  }
  return [...tags];
}

export function deriveUseCaseTags(pixabay = {}) {
  const themes = (pixabay.theme ?? []).map(normalizeTag);
  const useCase = new Set();

  for (const theme of themes) {
    if (/short|reel|tiktok|instagram/.test(theme)) {
      useCase.add("shorts");
    }
    if (/youtube|video/.test(theme)) {
      useCase.add("youtube");
    }
    if (/vlog/.test(theme)) {
      useCase.add("vlog");
    }
  }

  if (useCase.size === 0) {
    useCase.add("vlog");
  }

  return [...useCase];
}

export function deriveEnergyLevel(pixabay = {}) {
  const text = [
    ...(pixabay.mood ?? []),
    ...(pixabay.genre ?? []),
    ...(pixabay.movement ?? []),
  ].join(" ").toLowerCase();

  if (/energetic|upbeat|fast|chasing|running|restless|bright|dance|party|club/.test(text)) {
    return "high";
  }
  if (/calm|soft|slow|peace|ambient|relax/.test(text)) {
    return "low";
  }
  return "medium";
}

export function buildTrackId({ pixabayId, fileName }) {
  if (pixabayId) {
    return `pixabay_${pixabayId}`;
  }
  const stem = String(fileName ?? "track").replace(/\.[^.]+$/, "");
  return stem.replace(/[^a-zA-Z0-9_]+/g, "_").toLowerCase();
}
