import { buildOutputTimeline } from "../lib/build-output-timeline.js";

const OVERLAY_DURATION_SEC = 3.5;
const DEFAULT_BOOMERANG_HALF_SEC = 2.0;

function resolveSegmentRange(segment) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const audioOut = segment.audioOutSec ?? segment.videoOutSec ?? audioIn;
  return { audioIn, audioOut };
}

function findSegmentForScene(timeline, sceneId, sceneMeta) {
  const sceneStart = sceneMeta?.startSec ?? 0;
  const sceneEnd = sceneMeta?.endSec ?? sceneStart + (sceneMeta?.durationSec ?? 0);

  for (const segment of timeline) {
    const segSceneId = segment.videoRef?.sceneId ?? segment.audioRef?.sceneId;
    if (segSceneId === sceneId) {
      return segment;
    }

    const clipId = segment.videoRef?.clipId ?? segment.audioRef?.clipId;
    if (clipId !== sceneMeta?.clipId) {
      continue;
    }

    const { audioIn, audioOut } = resolveSegmentRange(segment);
    if (audioIn < sceneEnd && audioOut > sceneStart) {
      return segment;
    }
  }

  return null;
}

function lookupWord(wordId, metaCommandsByClip, timelineIndex) {
  for (const entry of metaCommandsByClip ?? []) {
    const fromArtifact = (entry.commands ?? []).find((command) => command.anchorWordId === wordId
      || command.startWordId === wordId
      || command.endWordId === wordId);
    if (fromArtifact) {
      return (timelineIndex?.words ?? []).find((word) => word.wordId === wordId)
        ?? (entry.words ?? []).find((word) => word.wordId === wordId);
    }
  }
  return (timelineIndex?.words ?? []).find((word) => word.wordId === wordId);
}

function sourceToOutputSec(sourceSec, segment) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const outputStart = segment.outputStartSec ?? 0;
  return outputStart + (sourceSec - audioIn);
}

function hasVoiceDirectiveCut(segment, startWordId, endWordId) {
  return (segment.cuts ?? []).some(
    (cut) => cut.reason === "voice_directive"
      && cut.startWordId === startWordId
      && cut.endWordId === endWordId,
  );
}

function hasVoiceDirectiveOverlay(segment, commandId) {
  return (segment.textOverlays ?? []).some(
    (overlay) => overlay.overlayId === `voice_${commandId}`,
  );
}

function flattenCommands(metaCommandsByClip = []) {
  const commands = [];
  for (const entry of metaCommandsByClip) {
    for (const command of entry.commands ?? []) {
      commands.push({
        ...command,
        clipId: entry.clipId,
      });
    }
  }
  return commands;
}

/**
 * Materialize voice meta-commands on the edit recipe timeline.
 *
 * @param {object} recipe
 * @param {Array<{ clipId: string, commands?: object[] }>} metaCommandsByClip
 * @param {object} timelineIndex
 * @returns {number} applied action count
 */
export function enrichRecipeVoiceDirectives(recipe, metaCommandsByClip = [], timelineIndex = {}) {
  const commands = flattenCommands(metaCommandsByClip);
  if (!commands.length) {
    return 0;
  }

  let applied = 0;

  for (let outputIdx = 0; outputIdx < (recipe.outputs ?? []).length; outputIdx++) {
    const output = recipe.outputs[outputIdx];
    if (!output.timeline?.length) {
      continue;
    }

    const enrichedTimeline = buildOutputTimeline(output);
    const timeline = [...output.timeline];

    for (const command of commands) {
      const sceneMeta = (timelineIndex.scenes ?? []).find(
        (scene) => scene.sceneId === command.sceneId,
      );
      const segment = findSegmentForScene(timeline, command.sceneId, sceneMeta);
      if (!segment) {
        continue;
      }

      const segIdx = timeline.findIndex((entry) => entry.segmentId === segment.segmentId);
      if (segIdx < 0) {
        continue;
      }

      const enrichedSegment = enrichedTimeline.find(
        (entry) => entry.segmentId === segment.segmentId,
      ) ?? segment;
      let updatedSegment = timeline[segIdx];

      if (command.removeInstructionFromAudio !== false
        && command.startWordId
        && command.endWordId
        && !hasVoiceDirectiveCut(updatedSegment, command.startWordId, command.endWordId)) {
        updatedSegment = {
          ...updatedSegment,
          cuts: [...(updatedSegment.cuts ?? []), {
            startWordId: command.startWordId,
            endWordId: command.endWordId,
            reason: "voice_directive",
          }],
        };
        applied += 1;
      }

      if (command.type === "add_text_overlay" && command.extractedText
        && !hasVoiceDirectiveOverlay(updatedSegment, command.commandId)) {
        const anchorWord = lookupWord(command.anchorWordId, metaCommandsByClip, timelineIndex);
        const outputStartSec = anchorWord
          ? sourceToOutputSec(anchorWord.start, enrichedSegment)
          : (enrichedSegment.outputStartSec ?? 0);
        const outputEndSec = Math.max(
          outputStartSec + 0.5,
          Math.round((outputStartSec + OVERLAY_DURATION_SEC) * 10) / 10,
        );

        updatedSegment = {
          ...updatedSegment,
          textOverlays: [
            ...(updatedSegment.textOverlays ?? []),
            {
              overlayId: `voice_${command.commandId}`,
              text: command.extractedText,
              outputStartSec,
              outputEndSec,
              style: "emphasis",
              role: "retention_beat",
            },
          ],
        };
        applied += 1;
      }

      if (command.type === "boomerang" || command.type === "reverse") {
        const playbackMode = command.type === "boomerang" ? "boomerang" : "reverse";
        const needsPlayback = updatedSegment.videoTransform?.playbackMode !== playbackMode;
        const needsMute = updatedSegment.audioPolicy !== "mute"
          && updatedSegment.audioPolicy !== "external";
        if (needsPlayback || needsMute) {
          updatedSegment = {
            ...updatedSegment,
            ...(needsMute ? { audioPolicy: "mute" } : {}),
            videoTransform: {
              ...(updatedSegment.videoTransform ?? {}),
              playbackMode,
              ...(playbackMode === "boomerang"
                ? { boomerangHalfSec: updatedSegment.videoTransform?.boomerangHalfSec ?? DEFAULT_BOOMERANG_HALF_SEC }
                : {}),
            },
          };
          applied += 1;
        }
      }

      timeline[segIdx] = updatedSegment;
    }

    recipe.outputs[outputIdx] = {
      ...output,
      timeline,
    };
  }

  return applied;
}
