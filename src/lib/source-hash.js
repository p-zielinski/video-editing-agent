import fs from "node:fs";
import { createHash } from "node:crypto";

/** Files larger than this hash only the first 64MB plus file size (see computeSourceContentHash). */
const PARTIAL_HASH_BYTES = 64 * 1024 * 1024;

/**
 * SHA-256 content fingerprint for cache invalidation.
 * Streams the full file for inputs up to 64MB; for larger files hashes the first 64MB
 * plus the total byte size so swaps/replacements are detected without reading entire files.
 *
 * @param {string} sourcePath
 * @returns {Promise<string|null>} hex digest, or null when the file is missing
 */
export async function computeSourceContentHash(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return null;
  }

  const stat = fs.statSync(sourcePath);
  const hash = createHash("sha256");

  if (stat.size > PARTIAL_HASH_BYTES) {
    const fd = fs.openSync(sourcePath, "r");
    try {
      const buffer = Buffer.alloc(PARTIAL_HASH_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, PARTIAL_HASH_BYTES, 0);
      hash.update(buffer.subarray(0, bytesRead));
      hash.update(String(stat.size));
    } finally {
      fs.closeSync(fd);
    }
  } else {
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(sourcePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  }

  return hash.digest("hex");
}
