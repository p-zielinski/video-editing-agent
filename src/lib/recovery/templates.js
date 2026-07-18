import { ARTIFACTS } from "../../pipeline/work-paths.js";
import { ERROR_CODES } from "./error-codes.js";

function runCommand(batchId, fromStep, { force = false } = {}) {
  const parts = ["node", "src/cli.js", "run", "--batch-id", batchId, "--from-step", fromStep];
  if (force) {
    parts.push("--force");
  }
  return parts.join(" ");
}

function enrichCommand(batchId, { source = "draft", target = "final", force = false } = {}) {
  const parts = [
    "node", "src/cli.js", "enrich",
    "--batch-id", batchId,
    "--source", source,
    "--target", target,
  ];
  if (force) {
    parts.push("--force");
  }
  return parts.join(" ");
}

function renderCommand(batchId, { outputId = null, fromPass = null, force = false } = {}) {
  const parts = ["node", "src/cli.js", "render", "--batch-id", batchId];
  if (outputId) {
    parts.push("--output-id", outputId);
  }
  if (fromPass) {
    parts.push("--from-pass", fromPass);
  }
  if (force) {
    parts.push("--force");
  }
  return parts.join(" ");
}

const STEP_DEFAULTS = {
  ingest: {
    prerequisites: ["Upewnij się, że folder wejściowy istnieje i zawiera pliki wideo/audio"],
    fromStep: "ingest",
  },
  transcribe: {
    prerequisites: ["Sprawdź OPENAI_API_KEY i limit quota Whisper"],
    fromStep: "transcribe",
  },
  meta_commands: {
    prerequisites: ["Upewnij się, że transkrypcje (01-words-*) są kompletne"],
    fromStep: "meta_commands",
  },
  audio_analysis: {
    prerequisites: ["Sprawdź środowisko Python (librosa, PANNs) i ffmpeg"],
    fromStep: "audio_analysis",
  },
  keyframes: {
    prerequisites: ["Sprawdź ffmpeg i dostęp do plików źródłowych"],
    fromStep: "keyframes",
  },
  twelvelabs: {
    prerequisites: ["Sprawdź TWELVELABS_API_KEY lub użyj --twelvelabs-stub"],
    fromStep: "twelvelabs",
  },
  vision: {
    prerequisites: ["Sprawdź środowisko Python (vision) lub użyj --vision-stub"],
    fromStep: "vision",
  },
  objects: {
    prerequisites: ["Sprawdź środowisko Python (objects) lub użyj --objects-stub"],
    fromStep: "objects",
  },
  index: {
    prerequisites: ["Upewnij się, że artefakty analizy klipów są kompletne"],
    fromStep: "index",
  },
  clip_profile: {
    prerequisites: ["Upewnij się, że timeline index istnieje"],
    fromStep: "clip_profile",
  },
  abstract: {
    prerequisites: ["Sprawdź OPENAI_API_KEY i limit quota GPT"],
    fromStep: "abstract",
  },
  topic_index: {
    prerequisites: ["Sprawdź OPENAI_API_KEY (embeddingi) i abstraction L1-L3"],
    fromStep: "topic_index",
  },
  spatial_index: {
    prerequisites: ["Sprawdź OpenCV/face detect lub użyj --face-stub"],
    fromStep: "spatial_index",
  },
  ai_video: {
    prerequisites: ["Sprawdź KLING_API_KEY lub użyj --ai-video-stub"],
    fromStep: "ai_video",
  },
  direct: {
    prerequisites: ["Sprawdź OPENAI_API_KEY i kompletność indeksów dla directora"],
    fromStep: "direct",
  },
  audio_enhancement: {
    prerequisites: [
      "Zainstaluj DeepFilterNet CLI (deepFilter w PATH)",
      "Ustaw DEEPFILTERNET_BIN jeśli binarka nie jest w PATH",
      "Opcjonalnie: DEEPFILTERNET_MODEL_PATH",
      "Dla CI/dev: AUDIO_ENHANCEMENT_PROVIDER=ffmpeg lub AUDIO_ENHANCEMENT_STUB=1",
    ],
    fromStep: "audio_enhancement",
  },
  review: {
    prerequisites: ["Popraw błędy walidacji w recipe draft lub uruchom enrich"],
    fromStep: "review",
  },
  thumbnails: {
    prerequisites: ["Sprawdź OPENAI_API_KEY i final recipe"],
    fromStep: "thumbnails",
  },
  publish: {
    prerequisites: ["Upewnij się, że final recipe i thumbnail plan istnieją"],
    fromStep: "publish",
  },
  render: {
    prerequisites: ["Sprawdź ffmpeg i ścieżki assetów; użyj --keep-tmp dla resume passów"],
    fromStep: null,
  },
};

const CLIP_ERROR_STEP_MAP = {
  [ERROR_CODES.TRANSCRIBE_CLIP_FAILED]: "transcribe",
  [ERROR_CODES.AUDIO_ANALYSIS_CLIP_FAILED]: "audio_analysis",
  [ERROR_CODES.KEYFRAMES_CLIP_FAILED]: "keyframes",
  [ERROR_CODES.TWELVELABS_CLIP_FAILED]: "twelvelabs",
  [ERROR_CODES.VISION_CLIP_FAILED]: "vision",
  [ERROR_CODES.OBJECTS_CLIP_FAILED]: "objects",
  [ERROR_CODES.AUDIO_ENHANCEMENT_CLIP_FAILED]: "audio_enhancement",
  [ERROR_CODES.AUDIO_ENH_DEEPFILTERNET_FAILED]: "audio_enhancement",
  [ERROR_CODES.AUDIO_ENH_PROVIDER_FAILED]: "audio_enhancement",
};

export function buildRecoveryFailure({
  code,
  step,
  batchId,
  message,
  cause = null,
  scope = null,
  forceRequired = false,
  artifactsToInvalidate = null,
  prerequisites = null,
}) {
  const resolvedStep = step ?? CLIP_ERROR_STEP_MAP[code] ?? "ingest";
  const defaults = STEP_DEFAULTS[resolvedStep] ?? STEP_DEFAULTS.ingest;
  const resolvedPrerequisites = prerequisites ?? defaults.prerequisites ?? [];

  let recoveryCommand;
  if (resolvedStep === "render") {
    recoveryCommand = renderCommand(batchId, {
      outputId: scope?.outputId ?? null,
      fromPass: scope?.pass ?? null,
      force: forceRequired,
    });
  } else if (code === ERROR_CODES.RECIPE_VALIDATION_FAILED) {
    recoveryCommand = runCommand(batchId, "review");
  } else if (defaults.fromStep) {
    recoveryCommand = runCommand(batchId, defaults.fromStep, { force: forceRequired });
  } else {
    recoveryCommand = runCommand(batchId, resolvedStep, { force: forceRequired });
  }

  let resolvedArtifacts = artifactsToInvalidate;
  if (!resolvedArtifacts && scope?.clipId) {
    if (resolvedStep === "audio_enhancement") {
      resolvedArtifacts = [
        ARTIFACTS.audioEnhancementManifest(scope.clipId),
        `enhanced-audio/${scope.clipId}.wav`,
      ];
    } else if (resolvedStep === "transcribe") {
      resolvedArtifacts = [ARTIFACTS.words(scope.clipId)];
    } else if (resolvedStep === "audio_analysis") {
      resolvedArtifacts = [ARTIFACTS.audioAnalysis(scope.clipId)];
    } else if (resolvedStep === "vision") {
      resolvedArtifacts = [ARTIFACTS.vision(scope.clipId)];
    }
  }

  if (code === ERROR_CODES.AUDIO_ENH_DEEPFILTERNET_FAILED) {
    resolvedPrerequisites.push(
      "Po naprawie: node src/cli.js run --batch-id "
        + `${batchId} --from-step audio_enhancement (bez --force — retry tylko failed klipów)`,
    );
  }

  return {
    code,
    step: resolvedStep,
    scope: scope ?? undefined,
    message,
    cause: cause ?? undefined,
    prerequisites: resolvedPrerequisites,
    recoveryCommand,
    artifactsToInvalidate: resolvedArtifacts ?? undefined,
    forceRequired: forceRequired || undefined,
  };
}

export function buildRecommendedCommand(failures, batchId) {
  if (failures.length === 0) {
    return runCommand(batchId, "ingest");
  }
  const primary = failures[0];
  if (primary.recoveryCommand) {
    return primary.recoveryCommand;
  }
  return runCommand(batchId, primary.step);
}

export { enrichCommand, renderCommand, runCommand };
