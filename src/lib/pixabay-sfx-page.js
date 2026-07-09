import fs from "node:fs";
import path from "node:path";
import { mapLabelToEditorialTag } from "../editorial/audio-event-tags.js";
import { getEffectiveSfxTags } from "../editorial/sfx-catalog-summary.js";
import { extractPixabayIdFromUrl } from "./pixabay-music-page.js";

const AUDIO_EXTENSIONS = [".wav", ".mp3", ".ogg", ".m4a", ".flac"];

/** @type {Array<{ match: RegExp, category: string }>} */
const CATEGORY_RULES = [
  { match: /whoosh|swoosh|swipe|transition|riser|sweep/i, category: "transition" },
  { match: /applause|laugh|cheer|crowd|reaction/i, category: "reaction" },
  { match: /wind|rain|thunder|ambient|nature|weather|room tone|atmosphere/i, category: "ambience" },
  { match: /impact|hit|click|bleep|door|footstep|ui|foley|explosion|bang/i, category: "foley" },
];

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

  return trimmed.split(/\s*,\s*/).map((part) => part.trim()).filter(Boolean);
}

function normalizeTag(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function extractSfxSlugFromUrl(url) {
  const match = String(url ?? "").match(/\/sound-effects\/([^/?#]+)\/?/);
  return match ? match[1] : null;
}

export function expectedAudioFileNamesFromUrl(url) {
  const slug = extractSfxSlugFromUrl(url);
  if (!slug) {
    return [];
  }
  return AUDIO_EXTENSIONS.map((ext) => `${slug}${ext}`);
}

/**
 * @param {string} url
 * @param {string[]} [existingFileNames]
 */
export function listAudioFileCandidatesForPixabayUrl(url, existingFileNames = []) {
  const candidates = [];
  const seen = new Set();

  function add(name) {
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    candidates.push(name);
  }

  for (const fileName of expectedAudioFileNamesFromUrl(url)) {
    add(fileName);
  }

  const pixabayId = extractPixabayIdFromUrl(url);
  if (pixabayId) {
    for (const fileName of existingFileNames) {
      const lower = fileName.toLowerCase();
      if (!AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        continue;
      }
      if (fileName.endsWith(`-${pixabayId}${path.extname(fileName)}`)
        || fileName.endsWith(`_${pixabayId}${path.extname(fileName)}`)) {
        add(fileName);
      }
    }
  }

  return candidates;
}

export function resolveSfxFileForPixabayUrl(url, sfxDir) {
  const existingFileNames = fs.existsSync(sfxDir)
    ? fs.readdirSync(sfxDir)
    : [];

  for (const fileName of listAudioFileCandidatesForPixabayUrl(url, existingFileNames)) {
    const filePath = path.join(sfxDir, fileName);
    if (fs.existsSync(filePath)) {
      const slugExpected = expectedAudioFileNamesFromUrl(url).includes(fileName);
      return {
        fileName,
        filePath,
        match: slugExpected ? "slug" : "pixabay_id",
      };
    }
  }

  return null;
}

function parseTagsFromHtml(html) {
  const tags = [];
  const dtPattern = /<dt[^>]*>\s*Tags\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let match = dtPattern.exec(html);
  while (match) {
    tags.push(...splitPixabayTagLine(match[1]));
    match = dtPattern.exec(html);
  }

  if (tags.length > 0) {
    return tags;
  }

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<[^>]+>/g, "\n");

  const textMatch = text.match(/(?:^|\n)\s*Tags\s*\n\s*([\s\S]*?)(?=\n\s*(?:Category|Comments|Media type|Free download)\b|$)/i);
  if (textMatch) {
    return splitPixabayTagLine(textMatch[1].replace(/\s+/g, " "));
  }

  return tags;
}

function parseCategoryFromHtml(html) {
  const match = html.match(/<dt[^>]*>\s*Category\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
  if (match) {
    const values = splitPixabayTagLine(match[1]);
    if (values[0]) {
      return values[0];
    }
  }
  return null;
}

export function extractTitleFromSfxHtml(html, url = "") {
  const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (ogMatch) {
    return ogMatch[1].split("|")[0].trim();
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    return h1Match[1].replace(/<[^>]+>/g, "").trim();
  }

  const slug = extractSfxSlugFromUrl(url);
  if (slug) {
    return slug
      .split("-")
      .slice(0, -1)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  return null;
}

export function deriveEditorialTags({ title = "", rawTags = [], pixabayCategory = null } = {}) {
  const tags = new Set();

  for (const raw of rawTags) {
    const normalized = normalizeTag(raw);
    if (normalized) {
      tags.add(normalized);
    }
    const mapped = mapLabelToEditorialTag(raw);
    if (mapped) {
      tags.add(mapped.tag);
    }
  }

  for (const source of [title, pixabayCategory]) {
    const mapped = mapLabelToEditorialTag(source);
    if (mapped) {
      tags.add(mapped.tag);
    }
  }

  return getEffectiveSfxTags({ title, tags: [...tags] });
}

export function deriveSfxCategory({ title = "", rawTags = [], editorialTags = [], pixabayCategory = null } = {}) {
  const mapped = mapLabelToEditorialTag(pixabayCategory ?? "");
  if (mapped?.category && mapped.category !== "music" && mapped.category !== "voice") {
    return mapped.category;
  }

  const text = [title, pixabayCategory, ...rawTags, ...editorialTags].filter(Boolean).join(" ");
  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(text)) {
      return rule.category;
    }
  }

  return "foley";
}

export function buildSfxId({ pixabayId, fileName }) {
  if (pixabayId) {
    return `pixabay_sfx_${pixabayId}`;
  }
  const stem = String(fileName ?? "sfx").replace(/\.[^.]+$/, "");
  return stem.replace(/[^a-zA-Z0-9_]+/g, "_").toLowerCase();
}

/**
 * @param {string} html
 * @param {{ url?: string, title?: string }} [options]
 */
export function parsePixabaySfxPage(html, { url = "", title = null } = {}) {
  const rawTags = parseTagsFromHtml(html);
  const pixabayCategory = parseCategoryFromHtml(html);
  const resolvedTitle = title ?? extractTitleFromSfxHtml(html, url);
  const pixabayId = extractPixabayIdFromUrl(url);
  const editorialTags = deriveEditorialTags({
    title: resolvedTitle ?? "",
    rawTags,
    pixabayCategory,
  });

  if (!resolvedTitle && rawTags.length === 0) {
    throw new Error(
      "Nie udało się sparsować metadanych SFX z Pixabay. Zapisz stronę w przeglądarce i użyj --html.",
    );
  }

  return {
    pixabayId,
    title: resolvedTitle ?? `Pixabay SFX ${pixabayId ?? "sound"}`,
    rawTags,
    pixabayCategory,
    tags: editorialTags,
    category: deriveSfxCategory({
      title: resolvedTitle ?? "",
      rawTags,
      editorialTags,
      pixabayCategory,
    }),
    sourceUrl: url || null,
  };
}
