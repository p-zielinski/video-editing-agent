import fs from "node:fs";
import path from "node:path";

/**
 * Create placeholder source files for clip paths referenced in scene catalog.
 */
export function seedClipSourceFiles(workDir) {
  const catalogPath = path.join(workDir, "00-scene-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const inboxDir = path.join(workDir, "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });

  for (const clip of catalog.clips ?? []) {
    const sourcePath = path.join(inboxDir, clip.fileName);
    if (!fs.existsSync(sourcePath)) {
      fs.writeFileSync(sourcePath, "");
    }
    clip.sourcePath = sourcePath;
  }

  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}
