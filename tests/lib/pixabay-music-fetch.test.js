import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBlockedPixabayHtml, hasPixabayMetadata, isReadyPixabayHtml, isTransientPixabayPageError, HEADED_CAPTCHA_WAIT_MS, normalizePixabayUrl, hasNextDataSectionMarkers } from "../../src/lib/pixabay-music-fetch.js";

describe("pixabay-music-fetch", () => {
  it("detects cloudflare challenge pages", () => {
    assert.equal(isBlockedPixabayHtml("<html><title>Just a moment...</title></html>"), true);
    assert.equal(isBlockedPixabayHtml("<html>Enable JavaScript and cookies to continue</html>"), true);
  });

  it("accepts pages with genre/mood markers", () => {
    assert.equal(
      isBlockedPixabayHtml("<html><body><dt>Genre</dt><dd>Dance</dd><dt>Mood</dt></body></html>"),
      false,
    );
    assert.equal(
      isBlockedPixabayHtml("<html><body><dt>Gatunek</dt><dd>Rock</dd><dt>Nastrój</dt></body></html>"),
      false,
    );
  });

  it("strips pixabay locale prefix from urls", () => {
    assert.equal(
      normalizePixabayUrl("https://pixabay.com/pl/music/g%C5%82az-indie-rock-518575/"),
      "https://pixabay.com/music/g%C5%82az-indie-rock-518575/",
    );
  });

  it("accepts __NEXT_DATA__ genre/mood markers on localized pages", () => {
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"genre":["Rock"],"mood":["Energetic"]}}}</script></body></html>`;
    assert.equal(hasNextDataSectionMarkers(html, "music"), true);
    assert.equal(isReadyPixabayHtml(html, "music"), true);
  });

  it("accepts sfx pages with tags markers", () => {
    assert.equal(
      isBlockedPixabayHtml("<html><body><dt>Tags</dt><dd>Whoosh</dd></body></html>", "sfx"),
      false,
    );
  });

  it("defaults headed captcha wait to at least 60 seconds", () => {
    assert.ok(HEADED_CAPTCHA_WAIT_MS >= 60_000);
  });

  it("requires Tags section for sfx metadata", () => {
    assert.equal(hasPixabayMetadata("<html>Free download Media type</html>", "sfx"), false);
    assert.equal(
      hasPixabayMetadata("<html><dt>Tags</dt><dd><a>Beep</a></dd></html>", "sfx"),
      true,
    );
  });

  it("isReadyPixabayHtml accepts live-page markers without dt tags", () => {
    assert.equal(
      isReadyPixabayHtml("<html><body>Tags Whoosh Free download</body></html>", "sfx"),
      true,
    );
  });

  it("treats navigation errors as transient", () => {
    assert.equal(
      isTransientPixabayPageError(new Error("Unable to retrieve content because the page is navigating")),
      true,
    );
  });
});
