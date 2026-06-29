import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";
import { drillDownSceneDetails } from "../lib/abstraction-chunking.js";
import { detectInputMode } from "../lib/input-mode.js";
import { loadTechniqueCatalog } from "../editorial/load-technique-catalog.js";
import {
  computeCreativityBudgetForRecipe,
  mergeCreativityProfile,
  parseCreativityFromContext,
  summarizeCreativityBudgetForBrief,
  synthesizeOutputsForBudget,
} from "../editorial/technique-budget.js";
import { formatCatalogForPrompt } from "../editorial/format-catalog-for-prompt.js";
import {
  buildRetentionBeatAnchors,
  buildRetentionTechniqueRotation,
  computeRetentionBeatTargets,
  formatRetentionGrammarForPrompt,
  mergeShortsRetentionProfile,
  mergeVlogRetentionProfile,
  parseRetentionFromContext,
  resolveMainOutputDurationSec,
  resolveShortOutputDurationSec,
  suggestRetentionMoments,
} from "../editorial/shorts-retention.js";
import { buildSpatialRefExamples } from "../editorial/spatial-ref.js";
import { buildAudioIndexSummary } from "../editorial/audio-index-summary.js";
import {
  buildBrollSyncHints,
  buildKeyframesByClip,
} from "../editorial/broll-sync-hints.js";
import { buildSfxPlanFromAudio } from "../editorial/sfx-plan.js";
import { listSfxCatalog } from "../editorial/sfx-library.js";
import {
  buildChapterCardHints,
  buildColdOpenSegmentHint,
  buildNarrativeOpenLoops,
} from "../editorial/chapter-hints.js";
import {
  buildDeadAirMontageHints,
  buildEditorialContext,
  buildTranscriptExcerpts,
  formatSpatialSummary,
} from "../editorial/editorial-context.js";
import { buildTopSceneRanks } from "../editorial/scene-rank.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";

const L1_SUMMARY_MAX_CHARS = 120;

function truncateSummary(text, maxLen = L1_SUMMARY_MAX_CHARS) {
  const s = text ?? "";
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, maxLen - 1)}…`;
}

const EDIT_RECIPE_V2_OUTPUT_SCHEMA = {
  version: "2.3",
  batchId: "string",
  batchContext: {
    inputMode: "single_clip|multi_clip_day",
    theme: "string?",
    requiredFormats: ["16:9", "9:16"],
    brollStrategy: "match_speech_topics",
    brollMatchThreshold: 0.55,
    qualityOverQuantity: true,
    allowBrollReuse: false,
    maxBrollSegmentsPerOutput: 30,
    shortsStrategy: "standalone_highlights",
    shortsMaxDurationSec: 60,
  },
  creativityProfile: {
    level: "safe|balanced|bold|shorts",
    allowMidSentenceCuts: false,
    techniquePack: "youtube_vlog_2026",
    maxTechniqueDensityPerMin: 0.3,
  },
  creativeMoments: [
    {
      momentId: "cm_001",
      techniqueId: "zoom_punch_in",
      outputId: "string",
      outputStartSec: 0,
      outputEndSec: 2.5,
      params: {},
      retentionRole: "hook|beat|payoff?",
      reason: "string",
      confidence: 0.85,
    },
  ],
  shortsRetentionProfile: {
    enabled: true,
    hookWindowSec: 3,
    retentionBeatIntervalSec: 25,
    requireHookMoment: true,
    requireHookOverlay: true,
    techniquePack: "shorts_retention_2026",
  },
  audioMixPlan: {
    voiceTargetLufs: -16,
    musicBed: {
      trackId: "string",
      volumeDb: -18,
      duckingDb: -12,
    },
    preWhisperNormalizeLufs: -18,
    segments: [
      {
        outputId: "string",
        musicInSec: 0,
        musicOutSec: 120,
        duckUnderVoice: true,
      },
    ],
  },
  clipRegistry: [],
  outputs: [
    {
      outputId: "string",
      format: "16:9|9:16",
      outputKind: "main|short",
      title: "string",
      timeline: [
        {
          segmentId: "string",
          segmentRole: "aroll|broll",
          videoRef: { clipId: "string", sceneId: "string" },
          audioRef: { clipId: "string", sceneId: "string" },
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
          audioPolicy: "from_video_ref|from_audio_ref|from_prev|from_next|external|mute",
          syncMode: "align_start",
          overlapSec: 0,
          cuts: [],
          intent: "string?",
        },
      ],
    },
  ],
  excluded: [
    {
      exclusionType: "whole_clip|scene|time_range",
      clipId: "string?",
      sceneId: "string?",
      usableAsBroll: false,
      reason: "string",
    },
  ],
  sceneUsageRegistry: [],
};

function resolveDirectorTechniquePack({
  contextProfile,
  retentionContext,
  preliminaryRetention,
  userContext,
}) {
  if (retentionContext?.techniquePack) {
    return retentionContext.techniquePack;
  }
  if (/shorts:\s*energy\s*high/.test(String(userContext).toLowerCase())) {
    return contextProfile.techniquePack ?? "shorts_energy";
  }
  if (preliminaryRetention.enabled) {
    return preliminaryRetention.techniquePack ?? contextProfile.techniquePack;
  }
  return contextProfile.techniquePack;
}

function buildCreativityContext({
  creativityProfile,
  userContext,
  batchContext = {},
  targetDurationSec,
  timelineIndex,
  outputs = [],
  requiredFormats = [],
  shortsRetentionProfile,
  vlogRetentionProfile,
  recipe = null,
}) {
  const contextProfile = creativityProfile ?? parseCreativityFromContext(userContext);
  const durationSec = targetDurationSec
    ?? timelineIndex.clips?.reduce((sum, c) => sum + (c.durationSec ?? 0), 0)
    ?? 600;

  const retentionContext = parseRetentionFromContext(userContext);
  const preliminaryRetention = mergeShortsRetentionProfile(
    shortsRetentionProfile ?? {},
    {
      userContext,
      outputs,
      requiredFormats,
      creativityProfile: contextProfile,
    },
  );

  const packId = resolveDirectorTechniquePack({
    contextProfile,
    retentionContext,
    preliminaryRetention,
    userContext,
  });

  const catalog = loadTechniqueCatalog({
    pack: packId,
    platforms: batchContext.targetPlatforms?.length
      ? batchContext.targetPlatforms
      : ["youtube", "shorts"],
  });

  const parsedCreativity = mergeCreativityProfile(contextProfile, {
    defaultCreativityLevel: catalog.pack?.defaultCreativityLevel,
  });

  if (retentionContext?.techniquePack) {
    parsedCreativity.techniquePack = retentionContext.techniquePack;
  } else if (
    preliminaryRetention.enabled
    && !/shorts:\s*energy\s*high/.test(String(userContext).toLowerCase())
    && preliminaryRetention.techniquePack
  ) {
    parsedCreativity.techniquePack = preliminaryRetention.techniquePack;
  }

  const shortsRetention = mergeShortsRetentionProfile(
    shortsRetentionProfile ?? {},
    {
      packRetentionDefaults: catalog.pack?.retentionDefaults,
      userContext,
      outputs,
      requiredFormats,
      creativityProfile: parsedCreativity,
    },
  );

  const vlogRetention = mergeVlogRetentionProfile(
    vlogRetentionProfile ?? {},
    {
      outputs,
      requiredFormats,
    },
  );

  const shortDurationSec = resolveShortOutputDurationSec({
    outputs,
    batchContext,
    targetDurationSec: durationSec,
  });
  const mainDurationSec = resolveMainOutputDurationSec({
    outputs,
    batchContext,
    targetDurationSec: durationSec,
  });
  const outputsForBudget = synthesizeOutputsForBudget({
    outputs,
    requiredFormats,
    durationSec,
    batchContext,
  });
  const recipeBudget = computeCreativityBudgetForRecipe(
    { outputs: outputsForBudget, vlogRetentionProfile: vlogRetention },
    parsedCreativity,
  );
  const creativityBudget = recipeBudget.default;
  const creativityBudgetByOutput = Object.fromEntries(
    Object.entries(recipeBudget.byOutputId).map(([outputId, outputBudget]) => [
      outputId,
      summarizeCreativityBudgetForBrief(outputBudget),
    ]),
  );
  const techniqueCatalog = formatCatalogForPrompt(catalog, creativityBudget);

  let retentionBeatTargets = [];
  let retentionBeatTargetsMain = [];
  let retentionBeatTargetsShort = [];
  let retentionTechniqueRotation;
  let retentionTechniqueRotationMain;
  let retentionTechniqueRotationShort;
  let retentionGrammarSummary = null;
  let activeRetentionProfile;

  const dualRetention = vlogRetention.enabled && shortsRetention.enabled;

  if (dualRetention) {
    retentionBeatTargetsMain = computeRetentionBeatTargets(mainDurationSec, vlogRetention, { mode: "vlog" });
    retentionTechniqueRotationMain = buildRetentionTechniqueRotation(
      retentionBeatTargetsMain.length,
      "vlog",
    );
    retentionBeatTargetsShort = computeRetentionBeatTargets(shortDurationSec, shortsRetention, { mode: "shorts" });
    retentionTechniqueRotationShort = buildRetentionTechniqueRotation(
      retentionBeatTargetsShort.length,
      "shorts",
    );
    retentionGrammarSummary = {
      main: formatRetentionGrammarForPrompt(
        vlogRetention,
        retentionBeatTargetsMain,
        { mode: "vlog", techniqueRotation: retentionTechniqueRotationMain },
      ),
      short: formatRetentionGrammarForPrompt(
        shortsRetention,
        retentionBeatTargetsShort,
        { mode: "shorts", techniqueRotation: retentionTechniqueRotationShort },
      ),
    };
    activeRetentionProfile = vlogRetention;
  } else if (vlogRetention.enabled) {
    retentionBeatTargets = computeRetentionBeatTargets(mainDurationSec, vlogRetention, { mode: "vlog" });
    retentionTechniqueRotation = buildRetentionTechniqueRotation(
      retentionBeatTargets.length,
      "vlog",
    );
    retentionGrammarSummary = formatRetentionGrammarForPrompt(
      vlogRetention,
      retentionBeatTargets,
      { mode: "vlog", techniqueRotation: retentionTechniqueRotation },
    );
    activeRetentionProfile = vlogRetention;
  } else if (shortsRetention.enabled) {
    retentionBeatTargets = computeRetentionBeatTargets(shortDurationSec, shortsRetention, { mode: "shorts" });
    retentionTechniqueRotation = buildRetentionTechniqueRotation(
      retentionBeatTargets.length,
      "shorts",
    );
    retentionGrammarSummary = formatRetentionGrammarForPrompt(
      shortsRetention,
      retentionBeatTargets,
      { mode: "shorts", techniqueRotation: retentionTechniqueRotation },
    );
    activeRetentionProfile = shortsRetention;
  }

  const retentionMomentSuggestions = recipe && activeRetentionProfile?.enabled
    ? suggestRetentionMoments(recipe, activeRetentionProfile, {
      mode: activeRetentionProfile.mode ?? "vlog",
    })
    : [];

  const retentionDurationSec = dualRetention
    ? mainDurationSec
    : (vlogRetention.enabled ? mainDurationSec : shortDurationSec);

  return {
    parsedCreativity,
    creativityBudget,
    creativityBudgetByOutput,
    techniqueCatalog,
    shortsRetention,
    vlogRetention,
    dualRetention,
    activeRetentionProfile,
    retentionGrammarSummary,
    retentionBeatTargets,
    retentionBeatTargetsMain,
    retentionBeatTargetsShort,
    retentionTechniqueRotation,
    retentionTechniqueRotationMain,
    retentionTechniqueRotationShort,
    retentionMomentSuggestions,
    retentionDurationSec,
    mainDurationSec,
    shortDurationSec,
  };
}

function buildRetentionBeatAnchorFields({
  dualRetention,
  activeRetentionProfile,
  vlogRetention,
  shortsRetention,
  editorialContext,
  abstraction,
  timelineIndex,
  mainDurationSec,
  shortDurationSec,
  retentionDurationSec,
  recipe,
  outputs,
}) {
  if (!editorialContext.audioIndex) {
    return {};
  }

  const mapOptions = {
    timelineIndex,
    recipe,
    outputs,
  };

  if (dualRetention) {
    const retentionBeatAnchorsMain = buildRetentionBeatAnchors(
      editorialContext.audioIndex,
      abstraction,
      vlogRetention,
      {
        ...mapOptions,
        durationSec: mainDurationSec,
        mode: "vlog",
        outputKind: "main",
      },
    );
    const retentionBeatAnchorsShort = buildRetentionBeatAnchors(
      editorialContext.audioIndex,
      abstraction,
      shortsRetention,
      {
        ...mapOptions,
        durationSec: shortDurationSec,
        mode: "shorts",
        outputKind: "short",
      },
    );

    return {
      ...(retentionBeatAnchorsMain.length ? { retentionBeatAnchorsMain } : {}),
      ...(retentionBeatAnchorsShort.length ? { retentionBeatAnchorsShort } : {}),
    };
  }

  if (!activeRetentionProfile?.enabled) {
    return {};
  }

  const retentionBeatAnchors = buildRetentionBeatAnchors(
    editorialContext.audioIndex,
    abstraction,
    activeRetentionProfile,
    {
      ...mapOptions,
      durationSec: retentionDurationSec,
      mode: activeRetentionProfile.mode ?? "vlog",
      outputKind: activeRetentionProfile.mode === "shorts" ? "short" : "main",
    },
  );

  return retentionBeatAnchors.length ? { retentionBeatAnchors } : {};
}

function buildRetentionBriefFields({
  shortsRetention,
  vlogRetention,
  dualRetention,
  activeRetentionProfile,
  retentionGrammarSummary,
  retentionBeatTargets,
  retentionBeatTargetsMain,
  retentionBeatTargetsShort,
  retentionTechniqueRotation,
  retentionTechniqueRotationMain,
  retentionTechniqueRotationShort,
  retentionMomentSuggestions,
}) {
  const base = {
    shortsRetentionProfile: shortsRetention.enabled ? shortsRetention : undefined,
    vlogRetentionProfile: vlogRetention.enabled ? vlogRetention : undefined,
    retentionGrammarSummary,
    retentionMomentSuggestions: retentionMomentSuggestions.length
      ? retentionMomentSuggestions
      : undefined,
  };

  if (dualRetention) {
    return {
      ...base,
      retentionBeatTargetsMain: retentionBeatTargetsMain.length
        ? retentionBeatTargetsMain
        : undefined,
      retentionBeatTargetsShort: retentionBeatTargetsShort.length
        ? retentionBeatTargetsShort
        : undefined,
      retentionTechniqueRotationMain: retentionTechniqueRotationMain?.length
        ? retentionTechniqueRotationMain
        : undefined,
      retentionTechniqueRotationShort: retentionTechniqueRotationShort?.length
        ? retentionTechniqueRotationShort
        : undefined,
    };
  }

  return {
    ...base,
    retentionBeatTargets: activeRetentionProfile?.enabled && retentionBeatTargets.length
      ? retentionBeatTargets
      : undefined,
    retentionTechniqueRotation: activeRetentionProfile?.enabled && retentionTechniqueRotation?.length
      ? retentionTechniqueRotation
      : undefined,
  };
}

function resolveRetentionRules(vlogRetention, shortsRetention) {
  if (!vlogRetention.enabled && !shortsRetention.enabled) {
    return undefined;
  }
  if (vlogRetention.enabled && shortsRetention.enabled) {
    return "V22-VLOG-01 … V22-VLOG-05 + V22-01 … V22-07";
  }
  if (vlogRetention.enabled) {
    return "V22-VLOG-01 … V22-VLOG-05";
  }
  return "V22-01 … V22-07";
}

function buildL1SceneSummaries(abstraction, scenes) {
  return scenes.map((scene) => {
    const l1 = (abstraction.L1 ?? []).find((entry) => entry.sceneId === scene.sceneId) ?? {};
    return {
      sceneId: scene.sceneId,
      summary: truncateSummary(l1.summary),
      mood: l1.mood,
      keyMoments: l1.keyMoments ?? [],
      brollPotential: l1.brollPotential,
      topics: l1.topics ?? [],
      visualQuality: l1.visualQuality,
      stability: l1.stability,
      isNarrationSource: l1.isNarrationSource ?? false,
    };
  });
}

export { buildL1SceneSummaries };

function buildSceneMapEntry(scene, abstraction) {
  const l1 = (abstraction.L1 ?? []).find((e) => e.sceneId === scene.sceneId) ?? {};
  return {
    sceneId: scene.sceneId,
    clipId: scene.clipId,
    startSec: scene.startSec,
    endSec: scene.endSec,
    durationSec: scene.durationSec,
    aspectRatio: scene.aspectRatio,
    hasSpeech: scene.hasSpeech,
    summary: truncateSummary(l1.summary),
    mood: l1.mood,
    keyMoments: l1.keyMoments ?? [],
    brollPotential: l1.brollPotential,
    topics: l1.topics ?? [],
    visualQuality: l1.visualQuality,
    stability: l1.stability,
    isNarrationSource: l1.isNarrationSource ?? false,
  };
}

function buildAspectMix(scenes = []) {
  const counts = {};
  for (const scene of scenes) {
    const key = scene.aspectRatio ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function buildClipAspectById(timelineIndex) {
  const map = {};
  for (const clip of timelineIndex?.clips ?? []) {
    if (clip.clipId && clip.aspectRatio) {
      map[clip.clipId] = clip.aspectRatio;
    }
  }
  return map;
}

function buildSfxCatalogSummary() {
  return listSfxCatalog().map((sound) => ({
    sfxId: sound.sfxId,
    tags: sound.tags ?? [],
    durationSec: sound.durationSec,
    label: sound.label ?? sound.sfxId,
  }));
}

function buildBrollCandidates(sceneEntries) {
  return sceneEntries
    .filter((s) => (s.brollPotential ?? 0) >= 0.5 || !s.hasSpeech)
    .map((s) => ({
      sceneId: s.sceneId,
      clipId: s.clipId,
      aspectRatio: s.aspectRatio,
      brollPotential: s.brollPotential ?? (s.hasSpeech ? 0.1 : 0.8),
      topics: s.topics,
      visualQuality: s.visualQuality,
    }));
}

function isArollClip(clipRegistry, clipId) {
  const entry = (clipRegistry ?? []).find((c) => c.clipId === clipId);
  return entry != null && String(entry.clipRole ?? "").startsWith("aroll");
}

const SCENE_MAP_COMPACT_THRESHOLD = 20;
const SCENE_MAP_RANK_SELECTION_LIMIT = 15;

/**
 * Selects timeline scenes for a compact director sceneMap on large batches.
 * @param {object} timelineIndex
 * @param {object} abstraction
 * @param {object} topicIndex
 * @param {object[]} clipRegistry
 * @param {object[]} sceneRanks — top-ranked scenes (up to 15 used)
 */
export function selectScenesForDirectorMap(
  timelineIndex,
  abstraction,
  topicIndex,
  clipRegistry,
  sceneRanks,
) {
  const topRankedIds = new Set(
    (sceneRanks ?? []).slice(0, SCENE_MAP_RANK_SELECTION_LIMIT).map((r) => r.sceneId),
  );

  const matchingSceneIds = new Set();
  for (const topic of topicIndex?.topics ?? []) {
    for (const match of topic.matchingScenes ?? []) {
      if (match.sceneId) {
        matchingSceneIds.add(match.sceneId);
      }
    }
  }

  return (timelineIndex.scenes ?? []).filter((scene) => {
    const l1 = (abstraction.L1 ?? []).find((e) => e.sceneId === scene.sceneId) ?? {};
    const brollPotential = l1.brollPotential ?? 0;

    return scene.hasSpeech
      || brollPotential >= 0.5
      || topRankedIds.has(scene.sceneId)
      || matchingSceneIds.has(scene.sceneId)
      || isArollClip(clipRegistry, scene.clipId);
  });
}

export {
  buildTranscriptExcerpts,
  extractSceneIdsFromRecipe,
  formatSpatialSummary,
} from "../editorial/editorial-context.js";

export function buildDirectorBrief({
  abstraction,
  timelineIndex,
  clipRegistry = [],
  topicIndex = { topics: [] },
  spatialIndex = { scenes: [] },
  audioIndex = null,
  audioMixDefaults = null,
  perClipAnalysis = null,
  wordIndexes = [],
  userContext,
  requiredFormats,
  batchContext = {},
  includeL1 = false,
  creativityProfile,
  targetDurationSec,
  keyframesByClip = null,
  recipe = null,
  outputs = null,
}) {
  const inputMode = detectInputMode(timelineIndex.clips?.length ?? 1, batchContext);
  const {
    parsedCreativity,
    creativityBudget,
    creativityBudgetByOutput,
    techniqueCatalog,
    shortsRetention,
    vlogRetention,
    dualRetention,
    activeRetentionProfile,
    retentionGrammarSummary,
    retentionBeatTargets,
    retentionBeatTargetsMain,
    retentionBeatTargetsShort,
    retentionTechniqueRotation,
    retentionTechniqueRotationMain,
    retentionTechniqueRotationShort,
    retentionMomentSuggestions,
    retentionDurationSec,
    mainDurationSec,
    shortDurationSec,
  } = buildCreativityContext({
    creativityProfile,
    userContext,
    batchContext,
    targetDurationSec,
    timelineIndex,
    requiredFormats,
  });

  const allSceneEntries = (timelineIndex.scenes ?? []).map((s) => buildSceneMapEntry(s, abstraction));
  const sceneRanksForSelection = buildTopSceneRanks(abstraction, timelineIndex, audioIndex, {
    clipRegistry,
    limit: SCENE_MAP_RANK_SELECTION_LIMIT,
  });
  const sceneRanks = sceneRanksForSelection.slice(0, 10);
  const sceneCount = timelineIndex.scenes?.length ?? allSceneEntries.length;
  const useCompactSceneMap = sceneCount > SCENE_MAP_COMPACT_THRESHOLD;

  let sceneMap = allSceneEntries;
  let sceneMapOmittedCount;
  let sceneMapPolicy;

  if (useCompactSceneMap) {
    const selectedScenes = selectScenesForDirectorMap(
      timelineIndex,
      abstraction,
      topicIndex,
      clipRegistry,
      sceneRanksForSelection,
    );
    const selectedIds = new Set(selectedScenes.map((s) => s.sceneId));
    sceneMap = allSceneEntries.filter((entry) => selectedIds.has(entry.sceneId));
    sceneMapOmittedCount = sceneCount - sceneMap.length;
    sceneMapPolicy = "compact_large_batch";
  }

  const brollCandidates = buildBrollCandidates(allSceneEntries);

  const excludedHints = clipRegistry
    .filter((c) => c.excludeFromMainStory || c.clipRole === "outtakes")
    .map((c) => ({
      clipId: c.clipId,
      clipRole: c.clipRole,
      reason: c.excludeReason ?? `clipRole: ${c.clipRole}`,
      confidence: c.roleConfidence,
    }));

  const fillerSamples = timelineIndex.scenes
    .map((scene) => {
      const fillers = timelineIndex.words
        .filter(
          (w) =>
            w.isFiller
            && w.start >= scene.startSec
            && w.start < scene.endSec,
        )
        .map((w) => ({ wordId: w.wordId, word: w.word, start: w.start, end: w.end }));

      return {
        sceneId: scene.sceneId,
        count: fillers.length,
        samples: fillers.slice(0, 12),
      };
    })
    .filter((entry) => entry.count > 0);

  const editorialContext = buildEditorialContext({
    timelineIndex,
    topicIndex,
    spatialIndex,
    audioIndex,
    includeFullTopicIndex: true,
    perClipAnalysis,
    wordIndexes,
  });

  const brief = {
    version: "2.2",
    batchContext: {
      ...batchContext,
      inputMode,
      requiredFormats,
    },
    inputMode,
    batchId: timelineIndex.batchId,
    userContext: userContext || timelineIndex.userContext || "",
    sessionSummary: abstraction.L3,
    segmentSummaries: abstraction.L2,
    clipRegistry,
    sceneRanks,
    topicIndex: editorialContext.topicIndex,
    spatialIndex: editorialContext.spatialIndex,
    spatialRefExamples: buildSpatialRefExamples(spatialIndex),
    sceneMap,
    aspectMix: buildAspectMix(timelineIndex.scenes ?? []),
    clipAspectById: buildClipAspectById(timelineIndex),
    sfxCatalogSummary: buildSfxCatalogSummary(),
    brollCandidates,
    excludedHints,
    fillerStats: {
      totalFillers: timelineIndex.stats?.fillerWordCount ?? 0,
      perScene: fillerSamples,
    },
    transcriptExcerpts: editorialContext.transcriptExcerpts,
    creativityProfile: parsedCreativity,
    techniqueCatalog,
    ...buildRetentionBriefFields({
      shortsRetention,
      vlogRetention,
      dualRetention,
      activeRetentionProfile,
      retentionGrammarSummary,
      retentionBeatTargets,
      retentionBeatTargetsMain,
      retentionBeatTargetsShort,
      retentionTechniqueRotation,
      retentionTechniqueRotationMain,
      retentionTechniqueRotationShort,
      retentionMomentSuggestions,
    }),
    audioIndex: editorialContext.audioIndex,
    audioMixDefaults,
    creativityBudget: summarizeCreativityBudgetForBrief(creativityBudget),
    creativityBudgetByOutput,
    constraints: {
      requiredFormats,
      brollMatchThreshold: batchContext.brollMatchThreshold ?? 0.55,
      maxBrollSegmentsPerOutput: batchContext.maxBrollSegmentsPerOutput ?? 30,
      shortsMaxDurationSec: batchContext.shortsMaxDurationSec ?? 60,
      sceneRegistryRules: "SR1-SR6",
      creativityRules: "V21-01 … V21-09",
      retentionRules: resolveRetentionRules(vlogRetention, shortsRetention),
    },
    qualityOverQuantity: batchContext.qualityOverQuantity ?? true,
    ...(sceneMapPolicy ? { sceneMapPolicy, sceneMapOmittedCount } : {}),
  };

  if ((topicIndex?.topics ?? []).length > 0) {
    const resolvedKeyframesByClip = keyframesByClip ?? buildKeyframesByClip(timelineIndex);
    brief.brollSyncHints = buildBrollSyncHints({
      topicIndex,
      timelineIndex,
      keyframesByClip: resolvedKeyframesByClip,
      abstractL1: abstraction.L1,
    }).slice(0, 15);
  }

  if (audioIndex?.clips?.length) {
    brief.sfxPlanDefaults = buildSfxPlanFromAudio(audioIndex, {
      maxEntries: 15,
      perClipAnalysis,
    });
  }

  const deadAirMontageHints = buildDeadAirMontageHints(editorialContext.audioIndex);
  if (deadAirMontageHints.length > 0) {
    brief.deadAirMontageHints = deadAirMontageHints;
  }

  const retentionBeatAnchorFields = buildRetentionBeatAnchorFields({
    dualRetention,
    activeRetentionProfile,
    vlogRetention,
    shortsRetention,
    editorialContext,
    abstraction,
    timelineIndex,
    mainDurationSec,
    shortDurationSec,
    retentionDurationSec,
    recipe,
    outputs,
  });
  Object.assign(brief, retentionBeatAnchorFields);

  const chapterCardHints = buildChapterCardHints(abstraction, {
    outputs: requiredFormats.includes("16:9")
      ? [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: mainDurationSec,
      }]
      : [],
    batchContext,
  });
  if (chapterCardHints.length > 0) {
    brief.chapterCardHints = chapterCardHints;
  }

  const narrativeOpenLoops = buildNarrativeOpenLoops(abstraction);
  if (narrativeOpenLoops.length > 0) {
    brief.narrativeOpenLoops = narrativeOpenLoops;
  }

  const coldOpenSegmentHint = buildColdOpenSegmentHint(abstraction, {
    outputs: requiredFormats.includes("16:9")
      ? [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: mainDurationSec,
      }]
      : [],
    batchContext,
  });
  if (coldOpenSegmentHint) {
    brief.coldOpenSegmentHint = coldOpenSegmentHint;
  }

  if (sceneCount <= 5) {
    brief.l1SceneSummaries = buildL1SceneSummaries(abstraction, timelineIndex.scenes);
  }

  if (includeL1) {
    brief.sceneSummariesL1 = abstraction.L1;
  }

  return brief;
}

export async function runDirector(client, {
  abstraction,
  timelineIndex,
  clipRegistry = [],
  topicIndex = { topics: [] },
  spatialIndex = { scenes: [] },
  audioIndex = null,
  audioMixDefaults = null,
  perClipAnalysis = null,
  wordIndexes = [],
  userContext,
  requiredFormats = ["16:9", "9:16"],
  batchContext = {},
}) {
  const system = loadPrompt("director", { version: "v2" });
  const brief = buildDirectorBrief({
    abstraction,
    timelineIndex,
    clipRegistry,
    topicIndex,
    spatialIndex,
    audioIndex,
    audioMixDefaults,
    perClipAnalysis,
    wordIndexes,
    userContext,
    requiredFormats,
    batchContext,
    includeL1: false,
  });

  const user = JSON.stringify({
    task: "initial_draft",
    brief,
    outputSchema: EDIT_RECIPE_V2_OUTPUT_SCHEMA,
  });

  const raw = await chatJson(client, {
    model: MODELS.director,
    system,
    user,
    temperature: 0.5,
  });

  raw.batchId = timelineIndex.batchId;
  raw.version = raw.version ?? "2.2";
  if (!raw.batchContext) {
    raw.batchContext = brief.batchContext;
  }
  raw.batchContext.requiredFormats = requiredFormats;
  raw.batchContext.inputMode = brief.inputMode;
  if (!raw.creativityProfile) {
    raw.creativityProfile = brief.creativityProfile;
  }
  if (!raw.shortsRetentionProfile && brief.shortsRetentionProfile) {
    raw.shortsRetentionProfile = brief.shortsRetentionProfile;
  }
  if (!raw.vlogRetentionProfile && brief.vlogRetentionProfile) {
    raw.vlogRetentionProfile = brief.vlogRetentionProfile;
  }
  if (!raw.creativeMoments) {
    raw.creativeMoments = [];
  }
  if (!raw.clipRegistry || raw.clipRegistry.length === 0) {
    raw.clipRegistry = clipRegistry;
  }

  return EditRecipeV2Schema.parse(raw);
}

export function filterL1ForScenes(abstraction, sceneIds) {
  const idSet = new Set(sceneIds);
  return (abstraction.L1 ?? []).filter((entry) => idSet.has(entry.sceneId));
}

export async function directorDrillDown(client, {
  abstraction,
  timelineIndex,
  clipRegistry = [],
  topicIndex = { topics: [] },
  spatialIndex = { scenes: [] },
  audioIndex = null,
  perClipAnalysis = null,
  wordIndexes = [],
  userContext,
  requiredFormats = ["16:9", "9:16"],
  batchContext = {},
  recipe,
  sceneIds,
  targetDurationSec,
}) {
  const system = loadPrompt("director", { version: "v2" });
  const drillDown = drillDownSceneDetails(timelineIndex, sceneIds);
  const sceneSummariesL1 = filterL1ForScenes(abstraction, sceneIds);
  const {
    parsedCreativity,
    creativityBudget,
    creativityBudgetByOutput,
    techniqueCatalog,
    shortsRetention,
    vlogRetention,
    dualRetention,
    activeRetentionProfile,
    retentionGrammarSummary,
    retentionBeatTargets,
    retentionBeatTargetsMain,
    retentionBeatTargetsShort,
    retentionTechniqueRotation,
    retentionTechniqueRotationMain,
    retentionTechniqueRotationShort,
    retentionMomentSuggestions,
    retentionDurationSec,
    mainDurationSec,
    shortDurationSec,
  } = buildCreativityContext({
    creativityProfile: recipe.creativityProfile,
    userContext,
    batchContext,
    targetDurationSec,
    timelineIndex,
    outputs: recipe.outputs,
    requiredFormats,
    shortsRetentionProfile: recipe.shortsRetentionProfile,
    vlogRetentionProfile: recipe.vlogRetentionProfile,
    recipe,
  });

  const editorialContext = buildEditorialContext({
    timelineIndex,
    recipe,
    sceneIds,
    topicIndex,
    spatialIndex,
    audioIndex,
    includeFullTopicIndex: false,
    perClipAnalysis,
    wordIndexes,
  });

  const user = JSON.stringify({
    task: "drill_down_refine",
    draftRecipe: recipe,
    drillDownSceneDetails: drillDown,
    sceneSummariesL1,
    topicIndex: editorialContext.topicIndex,
    spatialIndex: editorialContext.spatialIndex,
    spatialRefExamples: buildSpatialRefExamples(spatialIndex),
    transcriptExcerpts: editorialContext.transcriptExcerpts,
    audioIndex: editorialContext.audioIndex,
    clipRegistry,
    sessionSummary: abstraction.L3,
    userContext: userContext || timelineIndex.userContext || "",
    requiredFormats,
    creativityProfile: parsedCreativity,
    techniqueCatalog,
    ...buildRetentionBriefFields({
      shortsRetention,
      vlogRetention,
      dualRetention,
      activeRetentionProfile,
      retentionGrammarSummary,
      retentionBeatTargets,
      retentionBeatTargetsMain,
      retentionBeatTargetsShort,
      retentionTechniqueRotation,
      retentionTechniqueRotationMain,
      retentionTechniqueRotationShort,
      retentionMomentSuggestions,
    }),
    ...buildRetentionBeatAnchorFields({
      dualRetention,
      activeRetentionProfile,
      vlogRetention,
      shortsRetention,
      editorialContext,
      abstraction,
      timelineIndex,
      mainDurationSec,
      shortDurationSec,
      retentionDurationSec,
      recipe,
      outputs: recipe.outputs,
    }),
    creativityBudget: summarizeCreativityBudgetForBrief(creativityBudget),
    creativityBudgetByOutput,
    outputSchema: EDIT_RECIPE_V2_OUTPUT_SCHEMA,
  });

  const raw = await chatJson(client, {
    model: MODELS.director,
    system,
    user,
    temperature: 0.4,
  });

  raw.batchId = timelineIndex.batchId;
  raw.version = raw.version ?? "2.2";
  if (!raw.creativeMoments) {
    raw.creativeMoments = recipe.creativeMoments ?? [];
  }
  if (!raw.creativityProfile) {
    raw.creativityProfile = recipe.creativityProfile;
  }
  if (!raw.shortsRetentionProfile) {
    raw.shortsRetentionProfile = recipe.shortsRetentionProfile;
  }
  if (!raw.vlogRetentionProfile) {
    raw.vlogRetentionProfile = recipe.vlogRetentionProfile;
  }
  if (!raw.clipRegistry || raw.clipRegistry.length === 0) {
    raw.clipRegistry = clipRegistry;
  }

  return EditRecipeV2Schema.parse(raw);
}

export { EDIT_RECIPE_V2_OUTPUT_SCHEMA };
