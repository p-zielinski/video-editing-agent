#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "./pipeline/orchestrator.js";
import { checkPythonPreflight } from "./lib/python-bridge.js";
import { writeBatchQualityReport } from "./lib/batch-quality-report.js";
import { runBatchDoctor } from "./lib/batch-doctor.js";
import {
  formatRecoveryPlanReport,
  readRecoveryPlan,
} from "./lib/recovery/plan-writer.js";
import { QUALITY_PROFILES } from "./lib/quality-gate-config.js";
import { executeRender } from "./render/execute-render.js";
import { buildExecuteRenderOptions } from "./render/render-config.js";
import { runRecipeEnrichStep } from "./pipeline/steps/recipe-enrich.js";
import { PIPELINE_STEPS, validatePipelineStep, resolveWorkDir } from "./pipeline/work-paths.js";
import {
  PROFILES,
  resolveAnalysisProfile,
  listEnabledAnalysisStubs,
} from "./lib/analysis-profiles.js";

const COMMAND_DEFAULTS = {
  analyze: { fromStep: "ingest", toStep: "clip_profile" },
  direct: { fromStep: "abstract", toStep: "review" },
  full: {},
  run: {},
};

function printRenderResults(manifest, { dryRun = false } = {}) {
  if (dryRun) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  for (const entry of manifest.outputs) {
    if (entry.skipped) {
      console.log(`Pominięto (istnieje): ${entry.outputPath}`);
    } else if (!entry.outputPath) {
      const firstError = entry.segmentErrors?.[0];
      const detail = firstError
        ? `${firstError.segmentId ?? "segment"}: ${firstError.message?.split("\n")[0] ?? firstError.message}`
        : "nieznany błąd segmentu";
      console.log(`Render nieudany: ${entry.outputId ?? entry.format ?? "?"} — ${detail}`);
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

  const fidelityWarnings = manifest.fidelityWarnings ?? [];
  if (fidelityWarnings.length > 0) {
    console.log(`\nMontage fidelity (${fidelityWarnings.length}) — soft warn, render OK:`);
    for (const w of fidelityWarnings.slice(0, 15)) {
      console.log(`  - ${w.code}: ${w.message}`);
    }
    if (manifest.fidelityPath) {
      console.log(`  → ${manifest.fidelityPath}`);
    }
  }
}

function applyAnalysisProfile(args) {
  const resolved = resolveAnalysisProfile(args.analysisProfile, {
    visionStub: args.visionStub,
    faceStub: args.faceStub,
    audioStub: args.audioStub,
    objectsStub: args.objectsStub,
    twelvelabsStub: args.twelvelabsStub,
    globalCacheDisabled: args.noGlobalCache === true ? true : undefined,
  });

  args.visionStub = resolved.visionStub === true;
  args.faceStub = resolved.faceStub === true;
  args.audioStub = resolved.audioStub === true;
  args.objectsStub = resolved.objectsStub === true;
  args.twelvelabsStub = resolved.twelvelabsStub === true;
  args.noGlobalCache = resolved.globalCacheDisabled === true;

  const enabledStubs = listEnabledAnalysisStubs(resolved);
  if (args.analysisProfile) {
    console.log(`Profil analizy: ${args.analysisProfile}`);
  }
  if (enabledStubs.length > 0) {
    console.log(`Stuby analizy włączone: ${enabledStubs.join(", ")}`);
  }
  if (resolved.globalCacheDisabled) {
    console.log("Globalny cache analizy: wyłączony");
  }

  return resolved;
}

function resolveAnalysisStubFlags(args) {
  return {
    faceStub: args.faceStub === true,
    visionStub: args.visionStub === true,
    audioStub: args.audioStub === true,
  };
}

function resolveLivePythonFlags(args) {
  const { faceStub, visionStub, audioStub } = resolveAnalysisStubFlags(args);
  return {
    visionLive: !visionStub,
    faceLive: !faceStub,
    audioLive: !audioStub,
    objectsLive: args.objectsEnabled !== false && args.objectsStub !== true,
  };
}

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
      throw new Error(
        "Flaga --fast została usunięta. Domyślnie vision/face/audio są live. "
        + "W testach CI używaj jawnych flag: --vision-stub, --face-stub, --audio-stub.",
      );
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
    } else if (arg === "--no-twelvelabs") {
      args.twelvelabsEnabled = false;
    } else if (arg === "--twelvelabs-stub") {
      args.twelvelabsStub = true;
    } else if (arg === "--ai-video") {
      args.aiVideo = true;
    } else if (arg === "--ai-video-stub") {
      args.aiVideoStub = true;
    } else if (arg === "--no-ai-video") {
      args.noAiVideo = true;
    } else if (arg === "--reuse-llm-cache") {
      args.reuseLlmCache = true;
    } else if (arg === "--twelvelabs-live") {
      args.twelvelabsLive = true;
    } else if (arg === "--run") {
      args.runRecovery = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--no-global-cache") {
      args.noGlobalCache = true;
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
    } else if (arg === "--skip-creative") {
      args.skipCreative = true;
    } else if (arg === "--skip-subtitles") {
      args.skipSubtitles = true;
    } else if (arg === "--skip-overlays") {
      args.skipOverlays = true;
    } else if (arg === "--skip-audio-mix") {
      args.skipAudioMix = true;
    } else if (arg === "--skip-color-grade") {
      args.skipColorGrade = true;
    } else if (arg === "--keep-tmp") {
      args.keepTmp = true;
    } else if (arg === "--from-pass" && next) {
      args.fromPass = next;
      i += 1;
    } else if (arg === "--render") {
      args.renderAfterPipeline = true;
    } else if (arg === "--render-profile" && next) {
      args.renderProfile = next;
      i += 1;
    } else if (arg === "--allow-render-warnings") {
      args.allowRenderWarnings = true;
    } else if (arg === "--source" && next) {
      args.recipeSource = next;
      i += 1;
    } else if (arg === "--target" && next) {
      args.recipeTarget = next;
      i += 1;
    } else if (arg === "--max-review-iterations" && next) {
      args.maxReviewIterations = next;
      i += 1;
    } else if (arg === "--strict-review") {
      args.strictReview = true;
    } else if (arg === "--quality-profile" && next) {
      args.qualityProfile = next;
      i += 1;
    } else if (arg === "--analysis-profile" && next) {
      args.analysisProfile = next;
      i += 1;
    }
  }

  const defaults = COMMAND_DEFAULTS[args.command];
  if (defaults) {
    args.fromStep = args.fromStep ?? defaults.fromStep;
    args.toStep = args.toStep ?? defaults.toStep;
  }

  if (
    (args.command === "full" || args.command === "run")
    && process.env.PIPELINE_STRICT_REVIEW === "1"
    && args.strictReview !== true
  ) {
    args.strictReview = true;
  }

  return args;
}

export function resolveMaxReviewIterations(raw) {
  if (raw === undefined) {
    return 3;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error("--max-review-iterations musi być liczbą całkowitą od 1 do 10");
  }
  return parsed;
}

function needsLivePython(args) {
  const { visionLive, faceLive, audioLive, objectsLive } = resolveLivePythonFlags(args);

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
  const preflightOptions = resolveLivePythonFlags(args);

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
  node src/cli.js doctor --batch-id abc12345
  node src/cli.js recover --batch-id abc12345
  node src/cli.js recover --batch-id abc12345 --run
  node src/cli.js render --batch-id abc12345
  node src/cli.js enrich --batch-id abc12345 --source draft --target final --force
  node src/cli.js run --input ./inbox/day-11 --context "vlog" --render --render-profile preview
  node src/cli.js render --batch-id abc12345 --output-id horizontal_main --encode-profile draft
  node src/cli.js run --batch-id abc12345 --from-step abstract

Komendy:
  analyze   ingest → clip_profile (analiza wstępna)
  direct    abstract → review (reżyseria + pętla krytyka)
  full|run  pełny pipeline
  report    raport jakości batcha (pre-render)
  doctor    diagnostyka work dir i artefaktów batcha
  recover   pokaż lub uruchom plan recovery po failu pipeline
  render    montaż FFmpeg z 09-edit-recipe-final.json → MP4
  enrich    ponowny pass enricherów deterministycznych (bez GPT)

Opcje:
  --input <folder>         Folder z plikami wideo
  --batch-id <id>          Id batcha (domyślnie: nowy UUID)
  --from-step <step>         ingest|…|spatial_index|ai_video|direct|review|thumbnails|publish
  --to-step <step>         Zatrzymaj po wskazanym kroku
  --context <text>         Kontekst narracyjny dla reżysera
  --min-outputs <formats>  Domyślnie: 16:9,9:16
  --date-from <iso>        Filtruj klipy od daty (creation_time/mtime)
  --date-to <iso>          Filtruj klipy do daty
  --sort-by <field>        mtime|creation_time|name (domyślnie: creation_time przy ≥2 klipach, inaczej mtime)
  --force                  [cache artefaktów] Przelicz krok mimo świeżego artefaktu na dysku (artifact cache)
  --no-global-cache        Wyłącz globalny cache analizy (output/.cache/analysis)
  --vision-stub            Qwen2.5-VL stub zamiast live (tylko testy CI / dev)
  --face-stub              OpenCV face detect stub w spatial_index
  --audio-stub             Analiza audio stub (bez librosa)
  --vision-live            Wymuś Qwen2.5-VL live (nadpisuje wcześniejszy --vision-stub)
  --face-live              Wymuś face detect live (nadpisuje wcześniejszy --face-stub)
  --objects-stub           Florence-2 stub zamiast live (dev / brak GPU)
  --objects-live           [deprecated] domyślne od v0.1 — Florence-2 live
  --no-objects             Escape hatch: pomiń etap detekcji obiektów (dev)
  --no-keyframes           Nie ekstrahuj klatek (szybszy dry-run)
  --no-twelvelabs          Pomiń krok TwelveLabs (suplement wizji)
  --twelvelabs-stub        TwelveLabs stub (CI/testy; domyślnie live gdy TWELVELABS_API_KEY)
  --ai-video               Włącz generowanie hooków AI (Kling 3.0) dla shortów
  --ai-video-stub          Włącz AI video jako jawny lavfi stub zamiast Kling API
  --no-ai-video            Wyłącz AI video mimo flag w --context
  --reuse-llm-cache        [cache LLM, opt-in] Gdy krok się wykonuje — użyj llm-cache/*.json zamiast API (domyślnie: świeże wywołania)
  --twelvelabs-live        [deprecated] live jest domyślne przy ustawionym TWELVELABS_API_KEY
  --thumbnail-stub         Miniatury: plan deterministyczny bez GPT/renderu
  --no-thumbnail-render    Miniatury: plan + krytyk, bez PNG
  --dry-run                Render: tylko EDL JSON (bez FFmpeg)
  --output-id <id>         Render: jeden output z recipe
  --encode-profile <name>  Render: draft|production (domyślnie production)
  --render-profile <name>  Render: preview|iterate|production (preset passów)
  --format <16:9|9:16>     Render: filtruj outputy po formacie
  --skip-creative          Render: pomiń pass creativeMoments
  --skip-subtitles         Render: pomiń napisy ASS
  --skip-overlays          Render: pomiń text overlays
  --skip-audio-mix         Render: pomiń miks audio / SFX
  --skip-color-grade       Render: pomiń color grade
  --keep-tmp               Render: zachowaj pliki tymczasowe w renders/.tmp/
  --from-pass <pass>       Render: wznów od passu (concat|creative|subs|overlays|audio_mix|color_grade)
                           Wymaga --keep-tmp z pierwszego runu; przy istniejącym MP4 dodaj --force
  --allow-render-warnings  Render: kontynuuj mimo błędów V27-RENDER-* (fidelity)
  --render                 Po run/full: uruchom render z gotowej receptury
  --source <draft|final>   enrich: źródłowa receptura (domyślnie draft)
  --target <draft|final>   enrich: docelowa receptura (domyślnie draft)
  --max-review-iterations <n>  Pętla critic/fixer: 1–10 (domyślnie 3; produkcja: 5)
  --strict-review            Review: wymagaj zatwierdzenia krytyka przed zapisem final
  --quality-profile <name>     report: lenient|production|shorts (domyślnie lenient)
                               production/shorts: wymagają reviewApproved=true oraz braku stubów
  --analysis-profile <name>    preview|production|ci — preset stubów analizy (jawne flagi wygrywają)

Wymaga OPENAI_API_KEY w .env (komendy analyze/direct/full/run)
Render wymaga FFmpeg (+ libass dla napisów ASS)
`);
}

async function main() {
  const args = parseArgs(process.argv);
  const runnable = new Set(["run", "full", "analyze", "direct"]);
  const recoverOnly = args.command === "recover";
  const reportOnly = args.command === "report";
  const doctorOnly = args.command === "doctor";
  const renderOnly = args.command === "render";
  const enrichOnly = args.command === "enrich";

  if (args.command === "help" || (!runnable.has(args.command) && !reportOnly && !doctorOnly && !renderOnly && !enrichOnly && !recoverOnly)) {
    printHelp();
    process.exit(args.command === "help" ? 0 : 1);
  }

  if (!args.batchId && (reportOnly || doctorOnly || renderOnly || enrichOnly || recoverOnly || !args.input)) {
    console.error("Podaj --batch-id");
    process.exit(1);
  }

  if (doctorOnly) {
    const { report, exitCode } = runBatchDoctor({ batchId: args.batchId });
    console.log(report);
    process.exit(exitCode);
  }

  if (recoverOnly) {
    const workDir = resolveWorkDir(args.batchId);
    const plan = readRecoveryPlan(workDir);
    if (!plan) {
      console.error(`Brak ${"17-recovery-plan.json"} — batch nie ma oczekującego recovery`);
      process.exit(1);
    }
    console.log(formatRecoveryPlanReport(plan, { workDir }));
    if (args.runRecovery === true) {
      const { execSync } = await import("node:child_process");
      console.log(`\nUruchamiam: ${plan.recommendedCommand}`);
      execSync(plan.recommendedCommand, { stdio: "inherit", cwd: process.cwd() });
    }
    return;
  }

  if (reportOnly) {
    const workDir = resolveWorkDir(args.batchId);
    const qualityProfile = args.qualityProfile ?? "lenient";
    if (!QUALITY_PROFILES.includes(qualityProfile)) {
      console.error(`--quality-profile musi być jednym z: ${QUALITY_PROFILES.join("|")}`);
      process.exit(1);
    }
    const { summary, outPath } = writeBatchQualityReport(workDir, { qualityProfile });
    console.log(summary);
    if (qualityProfile === "production" || qualityProfile === "shorts") {
      console.log(
        "\nUwaga: profil production/shorts wymaga reviewApproved=true "
        + "(oraz spełnienia pozostałych bramek jakości).",
      );
    }
    console.log(`\nRaport: ${outPath}`);
    return;
  }

  if (enrichOnly) {
    const workDir = resolveWorkDir(args.batchId);
    const source = args.recipeSource ?? "draft";
    const target = args.recipeTarget ?? "draft";
    if (!["draft", "final"].includes(source) || !["draft", "final"].includes(target)) {
      console.error("--source i --target muszą być: draft lub final");
      process.exit(1);
    }

    const { validation, written } = await runRecipeEnrichStep({
      workDir,
      source,
      target,
      force: args.force === true,
      faceStub: args.faceStub === true,
      globalCacheDisabled: args.noGlobalCache === true,
    });

    console.log(`Enrich zapisany: ${written}`);
    console.log(`Walidacja: ${validation.valid ? "OK" : "BŁĄD"} (${validation.issues.length} issues)`);
    if (!validation.valid) {
      const errors = validation.issues.filter((issue) => issue.severity === "error");
      for (const issue of errors.slice(0, 5)) {
        console.log(`  - ${issue.code}: ${issue.message}`);
      }
      process.exit(target === "final" ? 2 : 0);
    }
    return;
  }

  if (renderOnly) {
    const workDir = args.outputDir
      ? path.resolve(args.outputDir)
      : resolveWorkDir(args.batchId);

    const { manifest } = await executeRender(workDir, buildExecuteRenderOptions(args));
    printRenderResults(manifest, { dryRun: args.dryRun === true });
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

  let maxReviewIterations;
  try {
    maxReviewIterations = resolveMaxReviewIterations(args.maxReviewIterations);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  await runPythonStartupCheck(args);

  try {
    applyAnalysisProfile(args);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const needsApiKey =
    !args.fromStep
    || ["transcribe", "abstract", "topic_index", "direct", "review", "thumbnails"].includes(args.fromStep)
    || args.command === "analyze"
    || args.command === "direct"
    || args.command === "full"
    || args.command === "run";
  if (needsApiKey && !apiKey && !args.thumbnailStub) {
    console.error("Brak OPENAI_API_KEY — ustaw w .env");
    process.exit(1);
  }

  const stubs = resolveAnalysisStubFlags(args);

  const result = await runPipeline({
    inputDir: args.input,
    batchId: args.batchId,
    fromStep: args.fromStep,
    toStep: args.toStep,
    apiKey,
    userContext: args.context ?? "",
    requiredFormats: args.requiredFormats ?? ["16:9", "9:16"],
    requiredFormatsExplicit: args.requiredFormatsExplicit === true,
    faceStub: stubs.faceStub,
    visionStub: stubs.visionStub,
    audioStub: stubs.audioStub,
    objectsStub: args.objectsStub === true,
    objectsEnabled: args.objectsEnabled !== false,
    twelvelabsEnabled: args.twelvelabsEnabled !== false,
    twelvelabsStub: args.twelvelabsStub,
    twelvelabsLive: args.twelvelabsLive === true,
    extractKeyframes: args.extractKeyframes !== false,
    force: args.force === true,
    thumbnailStub: args.thumbnailStub === true,
    renderThumbnails: args.renderThumbnails !== false,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    sortBy: args.sortBy,
    maxReviewIterations,
    strictReview: args.strictReview === true,
    globalCacheDisabled: args.noGlobalCache === true,
    aiVideo: args.aiVideo === true,
    aiVideoStub: args.aiVideoStub === true,
    noAiVideo: args.noAiVideo === true,
    reuseLlmCache: args.reuseLlmCache === true,
  });

  if (result.validationFailed) {
    if (result.recoveryPlan?.recommendedCommand) {
      console.error(`\nRecovery: ${result.recoveryPlan.recommendedCommand}`);
    }
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

  if (args.renderAfterPipeline) {
    if (!result.recipeFinal) {
      console.error("Brak finalnej receptury — render pominięty");
      process.exit(1);
    }
    const { manifest } = await executeRender(result.workDir, buildExecuteRenderOptions(args));
    printRenderResults(manifest, { dryRun: args.dryRun === true });
  }
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    if (error.recoveryPlan?.recommendedCommand) {
      console.error(`\nRecovery: ${error.recoveryPlan.recommendedCommand}`);
    }
    process.exit(1);
  });
}

export { parseArgs, COMMAND_DEFAULTS, resolveAnalysisStubFlags, resolveLivePythonFlags, applyAnalysisProfile };
export { buildExecuteRenderOptions } from "./render/render-config.js";
