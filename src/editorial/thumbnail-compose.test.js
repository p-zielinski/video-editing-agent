import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  THUMBNAIL_DIMENSIONS,
  buildThumbnailTextSvg,
  computeFaceAwareExtract,
  computeThumbnailFontSize,
  composeThumbnail,
  escapeSvgText,
  normalizeDetectionBboxToFrame,
  resolveThumbnailDimensions,
  resolveThumbnailFraming,
  resolveThumbnailSourceDimensions,
  wrapThumbnailHeadline,
} from "./thumbnail-compose.js";

describe("thumbnail-compose", () => {
  it("escapes SVG text and caps font size for long headlines", () => {
    assert.equal(escapeSvgText("A & B <test>"), "A &amp; B &lt;test&gt;");
    const fontSize = computeThumbnailFontSize("super duper long headline text", "16:9", 1280);
    assert.ok(fontSize < 120);
  });

  it("wraps headlines into at most two lines (not one word per line)", () => {
    assert.deepEqual(wrapThumbnailHeadline("NOWY ETAP START"), ["NOWY ETAP", "START"]);
    assert.deepEqual(wrapThumbnailHeadline("30 LAT ZA CHWILĘ"), ["30 LAT", "ZA CHWILĘ"]);
    assert.equal(wrapThumbnailHeadline("A B C D E").length, 2);
  });

  it("builds SVG with stroke text and accent bar covering all text lines", () => {
    const { w, h } = resolveThumbnailDimensions("9:16");
    const svg = buildThumbnailTextSvg({
      headline: "NOWY ETAP START",
      format: "9:16",
      width: w,
      height: h,
      style: "frame_text_accent",
    });

    assert.match(svg, /stroke="#000000"/);
    assert.match(svg, /<rect /);
    assert.match(svg, /NOWY ETAP/);
    assert.match(svg, /START/);
    assert.doesNotMatch(svg, /<tspan[^>]*>NOWY<\/tspan>\s*<tspan[^>]*>ETAP<\/tspan>\s*<tspan[^>]*>START<\/tspan>/);

    const rectMatch = svg.match(/<rect[^>]*y="(\d+)"[^>]*height="(\d+)"/);
    assert.ok(rectMatch);
    const barHeight = Number(rectMatch[2]);
    assert.ok(barHeight > 120, `accent bar should cover 2 lines, got height=${barHeight}`);
  });

  it("computes subject-aware extract placing subject toward center", () => {
    const extract = computeFaceAwareExtract({
      srcWidth: 1920,
      srcHeight: 1080,
      faceBbox: [0.1, 0.2, 0.2, 0.3],
      targetW: 1280,
      targetH: 720,
    });

    assert.ok(extract);
    assert.ok(extract.left >= 0);
    assert.ok(extract.top >= 0);
    assert.ok(extract.width > 0);
    assert.ok(extract.height > 0);
  });

  it("chooses blur_pad for portrait source into 16:9 target", () => {
    const framing = resolveThumbnailFraming({
      srcWidth: 2160,
      srcHeight: 3840,
      targetW: 1280,
      targetH: 720,
      subjectBbox: [0.2, 0.15, 0.5, 0.7],
    });
    assert.equal(framing.mode, "blur_pad");
  });

  it("swaps catalog landscape dims when detections imply portrait decode", () => {
    const dims = resolveThumbnailSourceDimensions({
      scene: { resolution: { w: 3840, h: 2160 } },
      detections: [
        { bbox: [1.08, 1787.52, 1547.64, 3834.24], label: "dog" },
      ],
    });
    assert.deepEqual(dims, { srcWidth: 2160, srcHeight: 3840 });
  });

  it("normalizes object bboxes with swapped orientation fallback", () => {
    const bbox = normalizeDetectionBboxToFrame(
      [1.08, 1787.52, 1547.64, 3834.24],
      3840,
      2160,
    );
    assert.ok(bbox);
    assert.ok(bbox[1] + bbox[3] <= 1.02, `dog bbox should fit frame: ${bbox}`);
    assert.ok(bbox[3] > 0.3, "dog should retain meaningful height");
  });

  it("composes PNG at target dimensions without real video", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-thumb-compose-"));
    const framePath = path.join(tmpDir, "frame.jpg");
    const outputPath = path.join(tmpDir, "thumb.png");

    await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 3,
        background: { r: 40, g: 80, b: 120 },
      },
    }).jpeg().toFile(framePath);

    await composeThumbnail({
      framePath,
      headline: "test miniatura",
      style: "frame_plus_text",
      format: "16:9",
      outputPath,
    });

    const meta = await sharp(outputPath).metadata();
    assert.equal(meta.width, THUMBNAIL_DIMENSIONS["16:9"].w);
    assert.equal(meta.height, THUMBNAIL_DIMENSIONS["16:9"].h);
    assert.equal(fs.existsSync(outputPath), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("composes portrait frame to 16:9 with blur pad (keeps vertical context)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-thumb-blur-"));
    const framePath = path.join(tmpDir, "portrait.jpg");
    const outputPath = path.join(tmpDir, "thumb.png");

    // Top = blue (face zone), bottom = green (dog zone)
    const top = await sharp({
      create: { width: 216, height: 192, channels: 3, background: { r: 20, g: 40, b: 200 } },
    }).png().toBuffer();
    const bottom = await sharp({
      create: { width: 216, height: 192, channels: 3, background: { r: 20, g: 180, b: 40 } },
    }).png().toBuffer();
    await sharp({
      create: { width: 216, height: 384, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([
        { input: top, top: 0, left: 0 },
        { input: bottom, top: 192, left: 0 },
      ])
      .jpeg()
      .toFile(framePath);

    await composeThumbnail({
      framePath,
      headline: "",
      style: "frame_only",
      format: "16:9",
      outputPath,
      subjectBbox: [0.1, 0.1, 0.8, 0.85],
    });

    const meta = await sharp(outputPath).metadata();
    assert.equal(meta.width, 1280);
    assert.equal(meta.height, 720);

    // Sample a center pixel — contain keeps both bands visible as a letterboxed portrait.
    const { data, info } = await sharp(outputPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cx = Math.floor(info.width / 2);
    const cyTop = Math.floor(info.height * 0.35);
    const cyBot = Math.floor(info.height * 0.65);
    const idx = (x, y) => (y * info.width + x) * info.channels;
    const topPx = [data[idx(cx, cyTop)], data[idx(cx, cyTop) + 1], data[idx(cx, cyTop) + 2]];
    const botPx = [data[idx(cx, cyBot)], data[idx(cx, cyBot) + 1], data[idx(cx, cyBot) + 2]];
    // Blue-ish top band and green-ish bottom band should both survive (not face-only crop).
    assert.ok(topPx[2] > topPx[1], `expected blue-ish top, got ${topPx}`);
    assert.ok(botPx[1] > botPx[2], `expected green-ish bottom, got ${botPx}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
