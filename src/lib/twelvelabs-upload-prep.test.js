import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessTwelveLabsUploadNeeds,
  prepareVideoForTwelveLabsUpload,
  resolveTwelveLabsProxyMaxBytes,
  splitVideoForTwelveLabsChunks,
  twelvelabsProxyPath,
} from "./twelvelabs-upload-prep.js";

describe("twelvelabs-upload-prep", () => {
  it("assessTwelveLabsUploadNeeds flags oversized files for proxy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-tl-prep-"));
    try {
      const filePath = path.join(dir, "big.bin");
      // sparse-ish: write 1 byte at offset to create large file cheaply is OS-dependent;
      // write a small file and mock via size check using a tiny file under limit.
      fs.writeFileSync(filePath, Buffer.alloc(1024));
      const small = assessTwelveLabsUploadNeeds({
        sourcePath: filePath,
        durationSec: 30,
        maxBytes: 10 * 1024,
      });
      assert.equal(small.needsProxy, false);

      const largePath = path.join(dir, "large.bin");
      fs.writeFileSync(largePath, Buffer.alloc(20 * 1024));
      const large = assessTwelveLabsUploadNeeds({
        sourcePath: largePath,
        durationSec: 30,
        maxBytes: 10 * 1024,
      });
      assert.equal(large.needsProxy, true);
      assert.equal(large.needsChunking, false);

      const long = assessTwelveLabsUploadNeeds({
        sourcePath: filePath,
        durationSec: 2000,
        maxBytes: 10 * 1024 * 1024,
        maxSingleDurationSec: 1200,
      });
      assert.equal(long.needsChunking, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prepareVideoForTwelveLabsUpload returns source when under limit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-tl-prep2-"));
    try {
      const filePath = path.join(dir, "clip.mp4");
      fs.writeFileSync(filePath, Buffer.alloc(512));
      let ffmpegCalls = 0;
      const result = await prepareVideoForTwelveLabsUpload({
        sourcePath: filePath,
        workDir: dir,
        clipId: "clip01",
        maxBytes: 10 * 1024,
        runFfmpegFn: async () => {
          ffmpegCalls += 1;
        },
      });
      assert.equal(result.uploadPath, filePath);
      assert.equal(result.proxied, false);
      assert.equal(ffmpegCalls, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prepareVideoForTwelveLabsUpload proxies when over limit and retries until under", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-tl-prep3-"));
    try {
      const filePath = path.join(dir, "clip.mp4");
      fs.writeFileSync(filePath, Buffer.alloc(50 * 1024));
      const proxyPath = twelvelabsProxyPath(dir, "clip01");
      let attempt = 0;
      const result = await prepareVideoForTwelveLabsUpload({
        sourcePath: filePath,
        workDir: dir,
        clipId: "clip01",
        maxBytes: 10 * 1024,
        runFfmpegFn: async (args) => {
          attempt += 1;
          const out = args[args.length - 1];
          fs.mkdirSync(path.dirname(out), { recursive: true });
          // First attempt still too large; second succeeds
          const size = attempt === 1 ? 20 * 1024 : 5 * 1024;
          fs.writeFileSync(out, Buffer.alloc(size));
        },
      });
      assert.equal(result.proxied, true);
      assert.equal(result.uploadPath, proxyPath);
      assert.equal(result.stillTooLarge, false);
      assert.ok(attempt >= 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splitVideoForTwelveLabsChunks creates offset segments", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-tl-chunks-"));
    try {
      const filePath = path.join(dir, "clip.mp4");
      fs.writeFileSync(filePath, Buffer.alloc(1024));
      const chunks = await splitVideoForTwelveLabsChunks({
        sourcePath: filePath,
        workDir: dir,
        clipId: "clip01",
        chunkDurationSec: 100,
        durationSec: 250,
        runFfmpegFn: async (args) => {
          const out = args[args.length - 1];
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, Buffer.alloc(100));
        },
      });
      assert.equal(chunks.length, 3);
      assert.equal(chunks[0].startSec, 0);
      assert.equal(chunks[1].startSec, 100);
      assert.equal(chunks[2].endSec, 250);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveTwelveLabsProxyMaxBytes reads env", () => {
    assert.equal(
      resolveTwelveLabsProxyMaxBytes({ TWELVELABS_PROXY_MAX_BYTES: "1048576" }),
      1048576,
    );
  });
});
