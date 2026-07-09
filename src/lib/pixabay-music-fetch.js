const CLOUDFLARE_MARKERS = /Just a moment|challenge-platform|cf_chl|Enable JavaScript and cookies/i;

/** Domyślny czas na captcha w widocznym Chromium (ms). */
export const HEADED_CAPTCHA_WAIT_MS = 180_000;

/** @type {Record<string, { metadataMarkers: RegExp, waitTexts: string[] }>} */
export const PIXABAY_PAGE_PROFILES = {
  music: {
    metadataMarkers: /Genre|Mood|Movement|Theme/i,
    waitTexts: ["Genre", "Mood"],
  },
  sfx: {
    metadataMarkers: /Tags|Tag|Category|Sound effects|sound-effects|Media type|Free download/i,
    waitTexts: ["Tags", "Tag", "Free download", "Sound Effect", "Media type"],
  },
};

export function isBlockedPixabayHtml(html, profileName = "music") {
  const profile = PIXABAY_PAGE_PROFILES[profileName] ?? PIXABAY_PAGE_PROFILES.music;
  const text = String(html ?? "");
  if (!text.trim()) {
    return true;
  }
  if (CLOUDFLARE_MARKERS.test(text)) {
    return true;
  }
  return !profile.metadataMarkers.test(text);
}

/** Stricter check: real metadata section present in static HTML (tests / saved pages). */
export function hasPixabayMetadata(html, profileName = "music") {
  if (!html || isBlockedPixabayHtml(html, profileName)) {
    return false;
  }
  if (profileName === "sfx") {
    return /<dt[^>]*>\s*Tags\s*<\/dt>/i.test(html);
  }
  return /<dt[^>]*>\s*Genre\s*<\/dt>/i.test(html)
    || /<dt[^>]*>\s*Mood\s*<\/dt>/i.test(html);
}

/** Browser fetch: accept live React HTML when markers visible and page not blocked. */
export function isReadyPixabayHtml(html, profileName = "music") {
  if (!html || CLOUDFLARE_MARKERS.test(html)) {
    return false;
  }
  if (hasPixabayMetadata(html, profileName)) {
    return true;
  }
  return !isBlockedPixabayHtml(html, profileName);
}

export function isTransientPixabayPageError(error) {
  const message = String(error?.message ?? "");
  return /navigating|destroyed|context|detached|closed|crashed/i.test(message);
}

async function fetchPixabayPageWithHttp(url, profileName) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} przy pobieraniu ${url}`);
    error.code = "PIXABAY_HTTP_ERROR";
    error.status = response.status;
    throw error;
  }

  const html = await response.text();
  if (isBlockedPixabayHtml(html, profileName)) {
    const error = new Error("Pixabay zwrócił stronę Cloudflare lub bez metadanych.");
    error.code = "PIXABAY_BLOCKED";
    throw error;
  }

  return { html, source: "http" };
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const error = new Error(
      "Brak pakietu playwright. Zainstaluj: npm install && npx playwright install chromium",
    );
    error.code = "PLAYWRIGHT_MISSING";
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read page HTML; return null while Cloudflare redirects / navigates (normal after captcha).
 * @param {import('playwright').Page} page
 */
export async function safePixabayPageContent(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    return await page.content();
  } catch (error) {
    if (isTransientPixabayPageError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Cloudflare / captcha visible in the live page (not every visit has one).
 * @param {import('playwright').Page} page
 */
export async function pageLooksBlocked(page) {
  try {
    return await page.evaluate(() => {
      const body = document.body?.innerText ?? "";
      return /Just a moment|Enable JavaScript and cookies|Verify you are human/i.test(body);
    });
  } catch {
    return false;
  }
}

/**
 * Metadata labels visible in rendered page (works with React DOM).
 * @param {import('playwright').Page} page
 */
export async function pageHasVisibleMetadata(page, profileName = "music") {
  const profile = PIXABAY_PAGE_PROFILES[profileName] ?? PIXABAY_PAGE_PROFILES.music;
  try {
    return await page.evaluate((texts) => {
      const body = document.body?.innerText ?? "";
      if (/Just a moment|Enable JavaScript and cookies/i.test(body)) {
        return false;
      }
      return texts.some((text) => body.includes(text));
    }, profile.waitTexts);
  } catch {
    return false;
  }
}

/**
 * Poll until metadata visible. Survives post-captcha navigation without closing browser.
 * @param {import('playwright').Page} page
 */
export async function waitForPixabayMetadataHtml(page, profileName, {
  headed = true,
  maxWaitMs = HEADED_CAPTCHA_WAIT_MS,
  pollIntervalMs = 2000,
} = {}) {
  const started = Date.now();
  let lastStatusLogSec = -1;
  let captchaHintShown = false;

  while (Date.now() - started < maxWaitMs) {
    const blocked = await pageLooksBlocked(page);
    const visible = await pageHasVisibleMetadata(page, profileName);

    if (headed && blocked && !captchaHintShown) {
      captchaHintShown = true;
      const minutes = Math.max(1, Math.round(maxWaitMs / 60_000));
      console.log(`  wykryto captcha / Cloudflare — masz do ~${minutes} min na rozwiązanie w oknie…`);
    }

    if (visible && !blocked) {
      const html = await safePixabayPageContent(page);
      if (html && isReadyPixabayHtml(html, profileName)) {
        return html;
      }
    }

    if (headed && blocked) {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      if (elapsedSec >= 10 && elapsedSec % 10 === 0 && elapsedSec !== lastStatusLogSec) {
        lastStatusLogSec = elapsedSec;
        console.log(`  … nadal czekam na captcha (${elapsedSec}s)`);
      }
    }

    const elapsed = Date.now() - started;
    await sleep(elapsed < 5000 ? 400 : pollIntervalMs);
  }

  const finalHtml = await safePixabayPageContent(page);
  return finalHtml ?? "";
}

/**
 * @param {string} url
 * @param {{ profileName?: string, headed?: boolean, timeoutMs?: number, captchaWaitMs?: number }} [options]
 */
export async function fetchPixabayPageWithBrowser(url, {
  profileName = "music",
  headed = true,
  timeoutMs = 60_000,
  captchaWaitMs = HEADED_CAPTCHA_WAIT_MS,
} = {}) {
  const profile = PIXABAY_PAGE_PROFILES[profileName] ?? PIXABAY_PAGE_PROFILES.music;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !headed });
  const navigationTimeoutMs = headed ? Math.max(timeoutMs, 90_000) : timeoutMs;
  const metadataWaitMs = headed ? Math.max(captchaWaitMs, 60_000) : Math.min(timeoutMs, 45_000);

  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeoutMs,
    }).catch((error) => {
      if (!headed || !isTransientPixabayPageError(error)) {
        throw error;
      }
    });

    const html = headed
      ? await waitForPixabayMetadataHtml(page, profileName, {
        headed: true,
        maxWaitMs: metadataWaitMs,
      })
      : await (async () => {
        const waitTextsJson = JSON.stringify(profile.waitTexts);
        await page.waitForFunction(
          (texts) => texts.some((text) => document.body?.innerText?.includes(text)),
          waitTextsJson,
          { timeout: metadataWaitMs },
        ).catch(() => {});
        await page.waitForTimeout(750);
        return safePixabayPageContent(page);
      })();

    const resolvedHtml = html ?? "";
    if (!isReadyPixabayHtml(resolvedHtml, profileName)) {
      const error = new Error(
        headed
          ? `Chromium nie uzyskał metadanych w ${Math.round(metadataWaitMs / 1000)}s — rozwiąż captcha i spróbuj ponownie.`
          : "Headless Chromium zablokowany — uruchom bez --headless (domyślnie widoczne okno).",
      );
      error.code = "PIXABAY_BLOCKED";
      throw error;
    }

    return { html: resolvedHtml, source: headed ? "chromium_headed" : "chromium_headless" };
  } finally {
    await browser.close();
  }
}

/**
 * @param {string} url
 * @param {{ profileName?: string, mode?: "browser" | "http" | "auto", headed?: boolean, timeoutMs?: number, captchaWaitMs?: number }} [options]
 */
export async function fetchPixabayPageHtml(url, {
  profileName = "music",
  mode = "browser",
  headed = true,
  timeoutMs = 60_000,
  captchaWaitMs = HEADED_CAPTCHA_WAIT_MS,
} = {}) {
  if (mode === "http") {
    return fetchPixabayPageWithHttp(url, profileName);
  }

  if (mode === "browser") {
    return fetchPixabayPageWithBrowser(url, {
      profileName,
      headed,
      timeoutMs,
      captchaWaitMs,
    });
  }

  try {
    return await fetchPixabayPageWithHttp(url, profileName);
  } catch (error) {
    if (error.code !== "PIXABAY_BLOCKED" && error.code !== "PIXABAY_HTTP_ERROR") {
      throw error;
    }
    return fetchPixabayPageWithBrowser(url, {
      profileName,
      headed,
      timeoutMs,
      captchaWaitMs,
    });
  }
}

export function fetchPixabayMusicPageHtml(url, options = {}) {
  return fetchPixabayPageHtml(url, { ...options, profileName: "music" });
}

export function fetchPixabaySfxPageHtml(url, options = {}) {
  return fetchPixabayPageHtml(url, { ...options, profileName: "sfx" });
}

export const fetchPixabayMusicPageWithBrowser = (url, options = {}) =>
  fetchPixabayPageWithBrowser(url, { ...options, profileName: "music" });
