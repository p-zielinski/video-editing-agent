import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { computeSourceContentHash } from "./source-hash.js";

describe("source-hash", () => {
  it("returns null for a missing file", async () => {
    const hash = await computeSourceContentHash(path.join(os.tmpdir(), "missing-file.mp4"));
    assert.equal(hash, null);
  });

  it("returns a stable SHA-256 hex digest for small files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-source-hash-"));
    const filePath = path.join(dir, "clip.mp4");
    const content = "hello-cache-invalidation";
    fs.writeFileSync(filePath, content);

    const expected = createHash("sha256").update(content).digest("hex");
    const hash = await computeSourceContentHash(filePath);

    assert.equal(hash, expected);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("changes when file content changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-source-hash-"));
    const filePath = path.join(dir, "clip.mp4");
    fs.writeFileSync(filePath, "version-a");

    const first = await computeSourceContentHash(filePath);
    fs.writeFileSync(filePath, "version-b");
    const second = await computeSourceContentHash(filePath);

    assert.notEqual(first, second);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hashes first 64MB plus file size for large files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-source-hash-large-"));
    const filePath = path.join(dir, "large.bin");
    const partialBytes = 64 * 1024 * 1024 + 1;
    const fd = fs.openSync(filePath, "w");
    try {
      fs.writeSync(fd, Buffer.alloc(partialBytes, 0xab));
    } finally {
      fs.closeSync(fd);
    }

    const stat = fs.statSync(filePath);
    const expected = createHash("sha256")
      .update(Buffer.alloc(64 * 1024 * 1024, 0xab))
      .update(String(stat.size))
      .digest("hex");

    const hash = await computeSourceContentHash(filePath);
    assert.equal(hash, expected);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
