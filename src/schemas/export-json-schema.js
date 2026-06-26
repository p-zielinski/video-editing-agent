import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  EditRecipeSchema,
  AbstractionBundleSchema,
  ReviewResultSchema,
} from "./edit-recipe.js";
import {
  EditRecipeV2Schema,
  TopicIndexSchema,
  ClipRegistryArtifactSchema,
} from "./edit-recipe-v2.js";
import {
  ClipAudioAnalysisSchema,
  AudioIndexSchema,
} from "./audio-analysis.js";
import { TimelineIndexSchema } from "./timeline-index.js";
import { SceneCatalogSchema } from "./scene-catalog.js";
import { WordIndexSchema } from "./word-index.js";
import { SpatialIndexSchema } from "./spatial-index.js";
import { ThumbnailPlanSchema, ThumbnailReviewSchema } from "./thumbnail-plan.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_DIR = path.join(ROOT, "schemas", "json");

const SCHEMAS = [
  { name: "EditRecipe", schema: EditRecipeSchema },
  { name: "EditRecipeV2", schema: EditRecipeV2Schema },
  { name: "TopicIndex", schema: TopicIndexSchema },
  { name: "ClipRegistry", schema: ClipRegistryArtifactSchema },
  { name: "TimelineIndex", schema: TimelineIndexSchema },
  { name: "SceneCatalog", schema: SceneCatalogSchema },
  { name: "WordIndex", schema: WordIndexSchema },
  { name: "SpatialIndex", schema: SpatialIndexSchema },
  { name: "ClipAudioAnalysis", schema: ClipAudioAnalysisSchema },
  { name: "AudioIndex", schema: AudioIndexSchema },
  { name: "AbstractionBundle", schema: AbstractionBundleSchema },
  { name: "ReviewResult", schema: ReviewResultSchema },
  { name: "ThumbnailPlan", schema: ThumbnailPlanSchema },
  { name: "ThumbnailReview", schema: ThumbnailReviewSchema },
];

export function exportJsonSchemas(outputDir = OUTPUT_DIR) {
  fs.mkdirSync(outputDir, { recursive: true });

  const written = [];
  for (const { name, schema } of SCHEMAS) {
    const jsonSchema = zodToJsonSchema(schema, { name, $refStrategy: "none" });
    const filePath = path.join(outputDir, `${name}.schema.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(jsonSchema, null, 2)}\n`, "utf8");
    written.push(filePath);
  }

  return written;
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  const files = exportJsonSchemas();
  console.log(`Exported ${files.length} JSON Schema files:`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
}
