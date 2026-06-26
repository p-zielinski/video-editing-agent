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
  resolveThumbnailDimensions,
} from "./thumbnail-compose.js";

describe("thumbnail-compose", () => {
  it("escapes SVG text and caps font size for long headlines", () => {
    assert.equal(escapeSvgText("A & B <test>"), "A &amp; B &lt;test&gt;");
    const fontSize = computeThumbnailFontSize("super duper long headline text", "16:9", 1280);
    assert.ok(fontSize < 120);
  });

  it("builds SVG with stroke text and accent bar", () => {
    const { w, h } = resolveThumbnailDimensions("9:16");
    const svg = buildThumbnailTextSvg({
      headline: "najlepsza restauracja",
      format: "9:16",
      width: w,
      height: h,
      style: "frame_text_accent",
    });

    assert.match(svg, /stroke="#000000"/);
    assert.match(svg, /<rect /);
    assert.match(svg, /NAJLEPSZA/);
  });

  it("computes face-aware extract placing face toward the right third", () => {
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
});
