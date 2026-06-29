#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import { runPipeline } from "./pipeline/orchestrator.js";
import { checkPythonPreflight } from "./lib/python-bridge.js";
import { writeBatchQualityReport } from "./lib/batch-quality-report.js";
import { executeRender } from "./render/execute-render.js";
import { PIPELINE_STEPS, validatePipelineStep, resolveWorkDir } from "./pipeline/work-paths.js";

const COMMAND_DEFAULTS = {
  analyze: { fromStep: "ingest", toStep: "index" },
  direct: { fromStep: "abstract", toStep: "review" },
  full: {},
  run: {},
};

function parseArgs(argv) {
  const args = {
    command: argv[2] ?? "help",
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--input" && next) {
      args.input = next;
      i += 1;
    } else if (arg === "--batch-id" && next) {
      args.batchId = next;
      i += 1;
    } else if (arg === "--from-step" && next) {
      args.fromStep = next;
      i += 1;
    } else if (arg === "--to-step" && next) {
      args.toStep = next;
      i += 1;
    } else if (arg === "--context" && next) {
      args.context = next;
      i += 1;
    } else if (arg === "--min-outputs" && next) {
      args.requiredFormats = next.split(",").map((s) => s.trim());
      args.requiredFormatsExplicit = true;
      i += 1;
    } else if (arg === "--date-from" && next) {
      args.dateFrom = next;
      i += 1;
    } else if (arg === "--date-to" && next) {
      args.dateTo = next;
      i += 1;
    } else if (arg === "--sort-by" && next) {
      args.sortBy = next;
      i += 1;
    } else if (arg === "--fast") {
      args.fast = true;
    } else if (arg === "--face-live") {
      args.faceLive = true;
      args.faceStub = false;
    } else if (arg === "--face-stub") {
      args.faceStub = true;
    } else if (arg === "--vision-live") {
      args.visionLive = true;
      args.visionStub = false;
    } else if (arg === "--vision-stub") {
      args.visionStub = true;
    } else if (arg === "--audio-stub") {
      args.audioStub = true;
    } else if (arg === "--objects-stub") {
      args.objectsStub = true;
    } else if (arg === "--objects-live") {
      args.objectsStub = false;
    } else if (arg === "--no-objects") {
      args.objectsEnabled = false;
    } else if (arg === "--no-keyframes") {
      args.extractKeyframes = false;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--thumbnail-stub") {
      args.thumbnailStub = true;
    } else if (arg === "--no-thumbnail-render") {
      args.renderThumbnails = false;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--output-id" && next) {
      args.outputId = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--encode-profile" && next) {
      args.encodeProfile = next;
      i += 1;
    } else if (arg === "--format" && next) {
      args.format = next;
      i += 1;
    }
  }

  const defaults = COMMAND_DEFAULTS[args.command];
  if (defaults) {
    args.fromStep = args.fromStep ?? defaults.fromStep;
    args.toStep = args.toStep ?? defaults.toStep;
  }

  return args;
}

function needsLivePython(args) {
  const objectsLive = args.objectsEnabled !== false && args.objectsStub !== true;
  const visionLive = args.visionStub !== true && (args.fast !== true || args.visionLive === true);
  const faceLive = args.faceStub !== true && (args.fast !== true || args.faceLive === true);
  const audioLive = args.audioStub !== true && args.fast !== true;

  if (visionLive) {
    return true;
  }

  const fromStep = args.fromStep ?? "ingest";
  const fromIndex = PIPELINE_STEPS.indexOf(fromStep);
  const ingestIndex = PIPELINE_STEPS.indexOf("ingest");
  const keyframesIndex = PIPELINE_STEPS.indexOf("keyframes");
  const visionIndex = PIPELINE_STEPS.indexOf("vision");
  const objectsIndex = PIPELINE_STEPS.indexOf("objects");
  const audioAnalysisIndex = PIPELINE_STEPS.indexOf("audio_analysis");

  if (fromIndex <= ingestIndex && args.input) {
    return true;
  }
  if (fromIndex <= keyframesIndex && fromIndex >= ingestIndex) {
    return true;
  }
  if (fromIndex <= visionIndex && visionLive) {
    return true;
  }
  if (fromIndex <= objectsIndex && objectsLive) {
    return true;
  }
  if (fromIndex <= audioAnalysisIndex && audioLive) {
    return true;
  }
  if (fromIndex <= PIPELINE_STEPS.indexOf("spatial_index") && faceLive) {
    return true;
  }

  return false;
}

async function runPythonStartupCheck(args) {
  const objectsLive = args.objectsEnabled !== false && args.objectsStub !== true;
  const visionLive = args.visionStub !== true && (args.fast !== true || args.visionLive === true);
  const faceLive = args.faceStub !== true && (args.fast !== true || args.faceLive === true);
  const audioLive = args.audioStub !== true && args.fast !== true;
  const preflightOptions = {
    visionLive,
    faceLive,
    objectsLive,
    audioLive,
  };

  try {
    const result = await checkPythonPreflight(preflightOptions);
    for (const warning of result.warnings ?? []) {
      console.warn(`Uwaga: ${warning}`);
    }
    return true;
  } catch (error) {
    if (needsLivePython(args)) {
      console.error(`Python preflight failed: ${error.message}`);
      process.exit(1);
    }
    console.warn(`Uwaga: Python niedostępny (${error.message}) — kroki wymagające Pythona zostaną pominięte lub użyją stubów.`);
    return false;
  }
}

function printHelp() {
  console.log(`
Video Editing Agent — analiza, reżyseria i montaż (FFmpeg)

Użycie:
  node src/cli.js run --input ./inbox/day-11 --context "vlog dzień 66/100"
  node src/cli.js analyze --input ./inbox/day-11
  node src/cli.js direct --batch-id abc12345 --context "vlog dzień 66/100"
  node src/cli.js report --batch-id abc12345
  node src/cli.js render --batch-id abc12345
  node src/cli.js render --batch-id abc12345 --output-id horizontal_main --encode-profile draft
  node src/cli.js run --batch-id abc12345 --from-step abstract

Komendy:
  analyze   ingest → index (analiza wstępna)
  direct    abstract → review (reżyseria + pętla krytyka)
  full|run  pełny pipeline
  report    raport jakości batcha (pre-render)
  render    montaż FFmpeg z 09-edit-recipe-final.json → MP4

Opcje:
  --input <folder>         Folder z plikami wideo
  --batch-id <id>          Id batcha (domyślnie: nowy UUID)
  --from-step <step>       ingest|transcribe|audio_analysis|keyframes|vision|objects|index|clip_profile|abstract|topic_index|spatial_index|direct|review|thumbnails
  --to-step <step>         Zatrzymaj po wskazanym kroku
  --context <text>         Kontekst narracyjny dla reżysera
  --min-outputs <formats>  Domyślnie: 16:9,9:16
  --date-from <iso>        Filtruj klipy od daty (creation_time/mtime)
  --date-to <iso>          Filtruj klipy do daty
  --sort-by <field>        mtime|creation_time|name (domyślnie: mtime)
  --force                  Przelicz kroki mimo istniejących artefaktów
  --fast                   Szybki tryb: vision/face/audio stub (dev)
  --vision-stub            Qwen2.5-VL stub zamiast live
  --face-stub              OpenCV face detect stub w spatial_index
  --audio-stub             Analiza audio stub (bez librosa)
  --vision-live            [alias] wymuś Qwen2.5-VL live
  --face-live              [alias] wymuś face detect live
  --objects-stub           Florence-2 stub zamiast live (dev / brak GPU)
  --objects-live           [deprecated] domyślne od v0.1 — Florence-2 live
  --no-objects             Escape hatch: pomiń etap detekcji obiektów (dev)
  --no-keyframes           Nie ekstrahuj klatek (szybszy dry-run)
  --thumbnail-stub         Miniatury: plan deterministyczny bez GPT/renderu
  --no-thumbnail-render    Miniatury: plan + krytyk, bez PNG
  --dry-run                Render: tylko EDL JSON (bez FFmpeg)
  --output-id <id>         Render: jeden output z recipe
  --encode-profile <name>  Render: draft|production (domyślnie production)
  --format <16:9|9:16>     Render: filtruj outputy po formacie

Wymaga OPENAI_API_KEY w .env (komendy analyze/direct/full/run)
Render wymaga FFmpeg (+ libass dla napisów ASS)
`);
}

async function main() {
  const args = parseArgs(process.argv);
  const runnable = new Set(["run", "full", "analyze", "direct"]);
  const reportOnly = args.command === "report";
  const renderOnly = args.command === "render";

  if (args.command === "help" || (!runnable.has(args.command) && !reportOnly && !renderOnly)) {
    printHelp();
    process.exit(args.command === "help" ? 0 : 1);
  }

  if (!args.batchId && (reportOnly || renderOnly || !args.input)) {
    console.error("Podaj --batch-id");
    process.exit(1);
  }

  if (reportOnly) {
    const workDir = resolveWorkDir(args.batchId);
    const { summary, outPath } = writeBatchQualityReport(workDir);
    console.log(summary);
    console.log(`\nRaport: ${outPath}`);
    return;
  }

  if (renderOnly) {
    const workDir = args.outputDir
      ? path.resolve(args.outputDir)
      : resolveWorkDir(args.batchId);

    const { results, manifest } = await executeRender(workDir, {
      dryRun: args.dryRun === true,
      force: args.force === true,
      outputId: args.outputId,
      format: args.format,
      encodeProfile: args.encodeProfile ?? "production",
    });

    if (args.dryRun) {
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }

    for (const entry of manifest.outputs) {
      if (entry.skipped) {
        console.log(`Pominięto (istnieje): ${entry.outputPath}`);
      } else {
        console.log(`Wyrenderowano: ${entry.outputPath} (${entry.durationSec?.toFixed(1) ?? "?"}s)`);
      }
    }
    if (manifest.warnings?.length) {
      console.log(`\nOstrzeżenia (${manifest.warnings.length}):`);
      for (const w of manifest.warnings.slice(0, 10)) {
        console.log(`  - ${w.code ?? "warn"}: ${w.message ?? JSON.stringify(w)}`);
      }
    }
    return;
  }

  if (!args.input && !args.batchId) {
    console.error("Podaj --input lub --batch-id");
    process.exit(1);
  }

  if (!args.input && args.batchId && args.command === "analyze") {
    console.error("Komenda analyze wymaga --input");
    process.exit(1);
  }

  if (!args.input && args.batchId && (!args.fromStep || args.fromStep === "ingest")) {
    console.error("Wznowienie bez --input wymaga --from-step (np. abstract) lub komendę direct");
    process.exit(1);
  }

  if (args.sortBy && !["mtime", "creation_time", "name"].includes(args.sortBy)) {
    console.error("--sort-by musi być: mtime, creation_time lub name");
    process.exit(1);
  }

  if (args.fromStep) {
    const stepError = validatePipelineStep(args.fromStep, "--from-step");
    if (stepError) {
      console.error(stepError);
      process.exit(1);
    }
  }

  if (args.toStep) {
    const stepError = validatePipelineStep(args.toStep, "--to-step");
    if (stepError) {
      console.error(stepError);
      process.exit(1);
    }
  }

  await runPythonStartupCheck(args);

  const apiKey = process.env.OPENAI_API_KEY;
  const needsApiKey =
    !args.fromStep
    || ["transcribe", "abstract", "direct", "review", "thumbnails"].includes(args.fromStep)
    || args.command === "analyze"
    || args.command === "direct"
    || args.command === "full"
    || args.command === "run";
  if (needsApiKey && !apiKey && !args.thumbnailStub) {
    console.error("Brak OPENAI_API_KEY — ustaw w .env");
    process.exit(1);
  }

  const result = await runPipeline({
    inputDir: args.input,
    batchId: args.batchId,
    fromStep: args.fromStep,
    toStep: args.toStep,
    apiKey,
    userContext: args.context ?? "",
    requiredFormats: args.requiredFormats ?? ["16:9", "9:16"],
    requiredFormatsExplicit: args.requiredFormatsExplicit === true,
    faceStub: args.faceStub === true || (args.fast === true && args.faceLive !== true),
    visionStub: args.visionStub === true || (args.fast === true && args.visionLive !== true),
    audioStub: args.audioStub === true || args.fast === true,
    objectsStub: args.objectsStub === true,
    objectsEnabled: args.objectsEnabled !== false,
    extractKeyframes: args.extractKeyframes !== false,
    force: args.force === true,
    thumbnailStub: args.thumbnailStub === true,
    renderThumbnails: args.renderThumbnails !== false,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    sortBy: args.sortBy ?? "mtime",
  });

  if (result.validationFailed) {
    console.error(
      `\nReceptura nie przeszła walidacji — draft zachowany w output/.work/${result.batchId}/${"07-edit-recipe-draft.json"}`,
    );
    process.exit(2);
  }

  if (result.recipeFinal) {
    console.log(`\nReceptura: ${result.recipeFinal}`);
  } else {
    console.log(`\nBatch: output/.work/${result.batchId}/`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

export { parseArgs, COMMAND_DEFAULTS };
