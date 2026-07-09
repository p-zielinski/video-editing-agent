const POLISH_MONTH_FORMS = new Set([
  "stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca",
  "lipca", "sierpnia", "września", "wrzesnia", "października", "pazdziernika",
  "listopada", "grudnia",
  "styczeń", "styczen", "luty", "marzec", "kwiecień", "kwiecien",
  "czerwiec", "lipiec", "sierpień", "sierpien", "wrzesień",
  "październik", "pazdziernik", "listopad", "grudzień", "grudzien",
]);

const ADD_TEXT_TARGETS = new Set(["datę", "date", "napis", "tekst", "data"]);

function normalizeToken(word) {
  return String(word ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function wordsToPhrase(words, startIdx, endIdx) {
  return words
    .slice(startIdx, endIdx + 1)
    .map((entry) => entry.word)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPolishMonth(token) {
  return POLISH_MONTH_FORMS.has(normalizeToken(token));
}

function extractPolishDate(words, fromIndex = 0) {
  for (let i = fromIndex; i < words.length - 1; i += 1) {
    const dayToken = normalizeToken(words[i].word);
    const monthToken = normalizeToken(words[i + 1].word);
    if (!/^\d{1,2}$/.test(dayToken) || !isPolishMonth(monthToken)) {
      continue;
    }

    let endIdx = i + 1;
    let text = `${words[i].word} ${words[i + 1].word}`;
    if (words[i + 2] && /^\d{4}$/.test(normalizeToken(words[i + 2].word))) {
      text = `${text} ${words[i + 2].word}`;
      endIdx = i + 2;
    }

    return { text, startIdx: i, endIdx };
  }
  return null;
}

function extendPhraseEnd(words, startIdx, { maxWords = 12, maxGapSec = 0.6 } = {}) {
  let endIdx = startIdx;
  for (let i = startIdx + 1; i < Math.min(words.length, startIdx + maxWords); i += 1) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > maxGapSec) {
      break;
    }
    endIdx = i;
  }
  return endIdx;
}

function resolveSceneId(word, scenes = []) {
  const scene = scenes.find(
    (entry) => word.start >= entry.startSec && word.start < entry.endSec,
  );
  return scene?.sceneId ?? scenes[0]?.sceneId ?? null;
}

function buildCommand({
  clipId,
  seq,
  type,
  anchorWord,
  endWord,
  sceneId,
  extractedText = null,
  removeInstructionFromAudio = true,
  confidence,
  rawPhrase,
  startWordId,
  endWordId,
}) {
  return {
    commandId: `${clipId}_mc${String(seq).padStart(3, "0")}`,
    type,
    anchorWordId: anchorWord.wordId,
    startWordId: startWordId ?? anchorWord.wordId,
    endWordId: endWordId ?? endWord.wordId,
    sceneId,
    extractedText,
    removeInstructionFromAudio,
    confidence,
    rawPhrase,
  };
}

function matchAddTextOverlay(words, scenes, clipId, seqStart) {
  const commands = [];
  let seq = seqStart;

  for (let i = 0; i < words.length; i += 1) {
    if (normalizeToken(words[i].word) !== "dodaj") {
      continue;
    }

    let offset = i + 1;
    if (words[offset] && normalizeToken(words[offset].word) === "tu") {
      offset += 1;
    }

    const targetWord = words[offset];
    if (!targetWord) {
      continue;
    }

    const targetToken = normalizeToken(targetWord.word);
    if (!ADD_TEXT_TARGETS.has(targetToken)) {
      continue;
    }

    const date = extractPolishDate(words, offset + 1);
    const phraseEndIdx = date?.endIdx ?? extendPhraseEnd(words, offset);
    const endWord = words[phraseEndIdx] ?? targetWord;
    const sceneId = resolveSceneId(words[i], scenes);
    const rawPhrase = wordsToPhrase(words, i, phraseEndIdx);

    commands.push(buildCommand({
      clipId,
      seq,
      type: "add_text_overlay",
      anchorWord: words[i],
      endWord,
      sceneId,
      extractedText: date?.text ?? null,
      confidence: date ? 0.92 : 0.85,
      rawPhrase,
      startWordId: words[i].wordId,
      endWordId: endWord.wordId,
    }));
    seq += 1;
    i = phraseEndIdx;
  }

  return { commands, nextSeq: seq };
}

function matchBoomerang(words, scenes, clipId, seqStart) {
  const commands = [];
  let seq = seqStart;

  for (let i = 0; i < words.length; i += 1) {
    const token = normalizeToken(words[i].word);
    if (token !== "zrob") {
      continue;
    }

    let offset = i + 1;
    if (words[offset] && normalizeToken(words[offset].word) === "tu") {
      offset += 1;
    }

    const effectWord = words[offset];
    if (!effectWord || normalizeToken(effectWord.word) !== "boomerang") {
      continue;
    }

    const phraseEndIdx = extendPhraseEnd(words, offset);
    const endWord = words[phraseEndIdx] ?? effectWord;
    const sceneId = resolveSceneId(effectWord, scenes);
    const rawPhrase = wordsToPhrase(words, i, phraseEndIdx);

    commands.push(buildCommand({
      clipId,
      seq,
      type: "boomerang",
      anchorWord: effectWord,
      endWord,
      sceneId,
      confidence: 0.9,
      rawPhrase,
      startWordId: words[i].wordId,
      endWordId: endWord.wordId,
    }));
    seq += 1;
    i = phraseEndIdx;
  }

  return { commands, nextSeq: seq };
}

function matchReverse(words, scenes, clipId, seqStart) {
  const commands = [];
  let seq = seqStart;

  for (let i = 0; i < words.length; i += 1) {
    const token = normalizeToken(words[i].word);
    let matched = false;
    let anchorWord = words[i];
    let endIdx = i;

    if (token === "cofnij") {
      matched = true;
    } else if (token === "odpalcie" && normalizeToken(words[i + 1]?.word) === "to"
      && normalizeToken(words[i + 2]?.word) === "wstecz") {
      matched = true;
      endIdx = i + 2;
      anchorWord = words[i];
    }

    if (!matched) {
      continue;
    }

    const endWord = words[endIdx] ?? anchorWord;
    const sceneId = resolveSceneId(anchorWord, scenes);
    const rawPhrase = wordsToPhrase(words, i, endIdx);

    commands.push(buildCommand({
      clipId,
      seq,
      type: "reverse",
      anchorWord,
      endWord,
      sceneId,
      confidence: token === "cofnij" ? 0.88 : 0.9,
      rawPhrase,
      startWordId: words[i].wordId,
      endWordId: endWord.wordId,
    }));
    seq += 1;
    i = endIdx;
  }

  return { commands, nextSeq: seq };
}

/**
 * Detect Polish voice meta-commands in a word transcript.
 *
 * @param {object[]} words
 * @param {{ scenes?: object[], clipId?: string }} [options]
 * @returns {object[]}
 */
export function extractMetaCommands(words, { scenes = [], clipId = "clip" } = {}) {
  if (!words?.length) {
    return [];
  }

  const sorted = [...words].sort((a, b) => a.start - b.start);
  const resolvedClipId = clipId ?? scenes[0]?.clipId ?? "clip";

  const addText = matchAddTextOverlay(sorted, scenes, resolvedClipId, 1);
  const boomerang = matchBoomerang(sorted, scenes, resolvedClipId, addText.nextSeq);
  const reverse = matchReverse(sorted, scenes, resolvedClipId, boomerang.nextSeq);

  return [...addText.commands, ...boomerang.commands, ...reverse.commands]
    .sort((a, b) => {
      const aWord = sorted.find((entry) => entry.wordId === a.anchorWordId);
      const bWord = sorted.find((entry) => entry.wordId === b.anchorWordId);
      return (aWord?.start ?? 0) - (bWord?.start ?? 0);
    })
    .map((command, index) => ({
      ...command,
      commandId: `${resolvedClipId}_mc${String(index + 1).padStart(3, "0")}`,
    }));
}

/**
 * Flatten per-clip meta command artifacts into brief-friendly voice directives.
 *
 * @param {Array<{ clipId: string, commands?: object[] }>} metaCommandsByClip
 * @returns {object[]}
 */
export function buildVoiceDirectivesFromMetaCommands(metaCommandsByClip = []) {
  const directives = [];

  for (const entry of metaCommandsByClip) {
    for (const command of entry.commands ?? []) {
      directives.push({
        ...command,
        clipId: entry.clipId,
      });
    }
  }

  return directives.sort((a, b) => a.commandId.localeCompare(b.commandId));
}
