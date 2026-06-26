# Formaty odpowiedzi AI i gotowość do montażu

> Last updated: 2026-06-26  
> Cel: jedno miejsce odpowiadające na pytania: *w jakim formacie odpowiada AI, w jakim reżyseruje, czy to wystarcza do fazy montażu?*

Powiązane: [`README.md`](../README.md), [`PRE_RENDER_PIPELINE.md`](./PRE_RENDER_PIPELINE.md), [`EDITING_RECIPE_V2_SPEC.md`](./EDITING_RECIPE_V2_SPEC.md), [`LUKI_PLAN_NAPRAWCZY.md`](./LUKI_PLAN_NAPRAWCZY.md), [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md)

---

## 1. Co robi ten projekt (a czego nie)

| Faza | Status |
|------|--------|
| Analiza materiału (Whisper, wizja, audio, indeksy) | **Gotowe** — 13 kroków pipeline |
| Reżyseria AI (plan montażu) | **Gotowe** — director → critic → fixer |
| Walidacja planu (Zod + reguły V21/V22/V23/V24) | **Gotowe** |
| Kontrakt renderu (EDL, kontekst, reframe, presety) | **Scaffold** — `src/render/` (bez FFmpeg) |
| **Render wideo** (cięcia FFmpeg, overlay, miks, eksport MP4) | **Nie zaimplementowane** |

Artefakt końcowy pre-renderu: `output/.work/<batchId>/09-edit-recipe-final.json` — receptura montażowa, nie plik wideo.

---

## 2. Przepływ danych (skrót)

```
inbox/*.MOV
    → analiza (01–06, 05a–05d)
    → summarizer (L1/L2/L3 JSON)
    → director (EditRecipe JSON)
    → critic + fixer (ReviewResult JSON → poprawiony EditRecipe)
    → 09-edit-recipe-final.json
    → resolveRenderContext() + buildRenderEdl()   [scaffold, src/render/]
    → [przyszły executor FFmpeg]
```

---

## 3. W jakim formacie odpowiada AI?

Wszystkie agenci zwracają **JSON** parsowany przez `chatJson()` (`src/agents/openai-client.js`) i walidowany schematami Zod / JSON Schema w `schemas/json/`.

### 3.1 Summarizer — abstrakcja wielopoziomowa

**Plik:** `06-abstract.json` (+ opcjonalnie `06-abstract-L1.json`, `L2`, `L3`)  
**Schemat:** `AbstractionBundle` (`schemas/json/AbstractionBundle.schema.json`)

| Poziom | Zadanie GPT | Przykładowe pola wyjścia |
|--------|-------------|--------------------------|
| **L1** | Streszczenie per scena | `sceneId`, `summary`, `mood`, `keyMoments[]`, `brollPotential`, `topics[]`, `visualQuality`, `stability` |
| **L2** | Segmenty narracyjne | `segmentId`, `sceneIds[]`, `summary`, `narrativeRole` |
| **L3** | Cała sesja | `sessionSummary`, `narrativeArc`, `recommendedFormats`, `estimatedKeepRatio`, `keywords[]` |

Summarizer **nie** tworzy timeline montażowego — tylko hierarchię opisów od scen do całego batcha.

### 3.2 Director — receptura montażowa

**Plik:** `07-edit-recipe-draft.json` → po review `09-edit-recipe-final.json`  
**Schemat:** `EditRecipeV2` (`schemas/json/EditRecipeV2.schema.json`, kod: `src/schemas/edit-recipe-v2.js`)  
**Wersje:** `2.0` … `2.4` (kumulatywnie: B-roll → creativeMoments → shorts retention → audioMixPlan → sfxPlan/colorGrade/renderStylePresets)

Director dostaje **brief** (nie zwraca go) — skondensowany JSON z `buildDirectorBrief()` (`src/agents/director.js`):

- `sessionSummary`, `segmentSummaries` (L3/L2)
- `sceneMap`, `sceneRanks`, `fillerStats`, `transcriptExcerpts`
- `clipRegistry`, `topicIndex`, `spatialIndex`, `audioIndex`
- `techniqueCatalog`, `creativityBudget`, opcjonalnie `shortsRetentionProfile`
- `brollSyncHints[]` (do 15 pozycji) — sugestie `videoInSec` z keyframes + L1 `keyMoments` (`src/editorial/broll-sync-hints.js`)

**Wyjście directora = pełny EditRecipe v2.x** (patrz §4).

### 3.3 Critic — ocena receptury

**Plik:** `08-review.json` (per iteracja)  
**Schemat:** `ReviewResult` v1.0 (`schemas/json/ReviewResult.schema.json`)

```json
{
  "version": "1.0",
  "batchId": "abc12345",
  "iteration": 1,
  "approved": false,
  "issues": [
    {
      "severity": "error|warning|suggestion",
      "code": "BROLL_AUDIO_MISMATCH",
      "message": "…",
      "outputId": "optional",
      "sceneId": "optional"
    }
  ],
  "summary": "Krótkie podsumowanie po polsku"
}
```

Critic łączy heurystyki deterministyczne (walidator Zod, scene registry SR1–SR6, V21/V22/V23/V24) z oceną jakościową GPT.

### 3.4 Fixer — poprawiona receptura

**Format wyjścia:** ponownie **EditRecipe v2.x** (ten sam schemat co director), naprawiający błędy z `issues[]` o severity `error`.

### 3.5 Thumbnail (opcjonalny, poza główną ścieżką montażu)

Agenci `thumbnail-strategist` / `thumbnail-critic` → `ThumbnailPlan` / `ThumbnailReview` — plan miniatury YouTube, nie timeline wideo.

---

## 4. W jakim formacie „reżyseruje” AI?

Reżyseria = **EditRecipe JSON** — deklaratywny plan montażu z rozdzielonymi ścieżkami audio i wideo.

### 4.1 Korzeń receptury

| Pole | Rola |
|------|------|
| `version` | `"2.0"` … `"2.4"` |
| `batchId` | Id batcha |
| `batchContext` | Tryb wejścia, formaty, strategia B-roll, shorty (`src/lib/input-mode.js`) |
| `clipRegistry[]` | Role plików: `aroll_primary`, `broll_pool`, `outtakes`, … |
| `outputs[]` | Jeden element = jeden docelowy render (16:9 main, 9:16 short, …) |
| `excluded[]` | `whole_clip` / `scene` / `time_range` + `usableAsBroll` |
| `sceneUsageRegistry[]` | Śledzenie reuse scen (walidacja SR1–SR6) |
| `creativityProfile` | (v2.1+) poziom montażu, pack technik |
| `creativeMoments[]` | (v2.1+) zabiegi: zoom, cięcia, overlay — **osobna warstwa od segmentów** |
| `shortsRetentionProfile` | (v2.2+) gramatyka hooków i beatów retencji |
| `audioMixPlan` | (v2.3+) LUFS, muzyka bed, ducking — **plan, bez wykonania miksu** |
| `sfxPlan[]` | (v2.4+) plan SFX — śmiech, whoosh, impact itd. |
| `colorGrade` | (v2.4+) LUT + exposure/contrast/saturation — **plan, egzekucja w rendererze** |
| `renderStylePresets` | (v2.4+) font, kolor, safe zones napisów i overlayów |
| `needsHumanReview` | Flaga po pętli critic/fixer |

### 4.2 EditRecipe v2.4 — nowe pola renderowe

Wersja `2.4` rozszerza plan o trzy warstwy potrzebne rendererowi, bez zmiany semantyki segmentów timeline.

#### `sfxPlan[]`

Tablica wpisów SFX zsynchronizowanych z osią outputu. Schemat: `SfxPlanEntrySchema` w `src/schemas/edit-recipe-v2.js`.

```json
{
  "sfxId": "evt_clip01_12500",
  "source": "audio_event",
  "clipId": "clip01",
  "anchorTimeSec": 12.5,
  "outputStartSec": 12.5,
  "outputEndSec": 12.9,
  "volumeDb": -6,
  "label": "laughter",
  "reason": "Detected Laughter (score 0.72)"
}
```

| Pole | Znaczenie |
|------|-----------|
| `source` | `audio_event` (z detekcji PANNs w analizie) lub `library` (tag editorialny bez timingu) |
| `clipId` | Wymagane dla `audio_event` — źródło zdarzenia w materiale |
| `anchorTimeSec` | Czas w klipie źródłowym (opcjonalny dla `library`) |
| `outputStartSec` / `outputEndSec` | Pozycja na timeline outputu |
| `volumeDb` | Domyślnie `-6` |

**Helper pre-render:** `buildSfxPlanFromAudio()` w `src/editorial/sfx-plan.js` buduje propozycję z `05d-audio-index.json` i `01b-audio-analysis-<clip>.json` (`audioEvents`, `editorialTags`). Director może emitować `sfxPlan[]` w recepturze; helper **nie jest jeszcze** automatycznie wpinany w pipeline — służy do propozycji lub post-processingu.

Walidacja: V24-01…V24-03 w `src/validators/recipe-v2.js`.

#### `colorGrade`

Opcjonalny blok korekcji koloru przed eksportem:

```json
{
  "lutId": "vlog_warm",
  "exposure": 0.1,
  "contrast": 1.05,
  "saturation": 1.1
}
```

Pole `lutId` to identyfikator LUT do rozwiązania w przyszłym rendererze. **Katalog `assets/luts/` nie istnieje jeszcze w repozytorium** — schemat i walidator Zod są gotowe; pliki LUT to faza FFmpeg.

#### `renderStylePresets`

Nadpisanie domyślnych presetów renderu (`src/render/style-presets.js` → `DEFAULT_RENDER_STYLE_PRESETS`):

```json
{
  "subtitles": {
    "presetId": "default_bold",
    "fontFamily": "Arial",
    "fontSizePx": 42,
    "color": "#FFFFFF",
    "strokeColor": "#000000",
    "safeMarginPct": 8
  },
  "overlays": {
    "hook_large": {
      "position": "center",
      "fontSizePx": 72,
      "fontFamily": "Arial Black",
      "color": "#FFFFFF",
      "strokeColor": "#000000"
    }
  },
  "formats": {
    "9:16": {
      "width": 1080,
      "height": 1920,
      "safeZone": { "top": 120, "bottom": 200, "left": 48, "right": 48 }
    }
  }
}
```

Walidacja: V24-04 (ostrzeżenie gdy output `9:16` bez `safeZone`), V24-05 (budżet czasu vs `estimatedKeepRatio`).

### 4.3 Segment montażowy (`outputs[].timeline[]`)

Każdy segment opisuje **jeden kawałek** składanki:

```json
{
  "segmentId": "seg_012",
  "segmentRole": "aroll | broll",
  "videoRef": { "clipId": "clip03", "sceneId": "clip03_scene002" },
  "audioRef": { "clipId": "clip01", "sceneId": "clip01_scene008" },
  "videoInSec": 12.0,
  "videoOutSec": 18.0,
  "audioInSec": 45.0,
  "audioOutSec": 51.0,
  "audioPolicy": "from_audio_ref | from_video_ref | from_prev | from_next | external | mute",
  "syncMode": "align_start | align_end | fit_video_to_audio | loop_video | …",
  "overlapSec": 0,
  "cuts": [{ "startWordId": "clip01_w0042", "endWordId": "clip01_w0048", "reason": "filler" }],
  "subtitles": { "policy": "word_by_word", "sourceClipId": "clip01" },
  "textOverlays": [{ "text": "…", "outputStartSec": 0.5, "outputEndSec": 4.0, "style": "hook_large", "role": "hook" }],
  "videoTransform": { "reframe": "center", "speed": 1 },
  "intent": "Opis intencji dla montażysty / review"
}
```

**Reguły kanoniczne (normatywne):**

- `MediaRef` = tylko `{ clipId, sceneId }` — **bez czasów w ref**
- Czasy zawsze na segmencie: `videoInSec/OutSec`, `audioInSec/OutSec`
- Cross-clip B-roll: `audioRef.clipId ≠ videoRef.clipId`, `audioPolicy: "from_audio_ref"`
- `cuts[].wordIds` muszą należeć do transkryptu `audioRef.clipId` (nie `videoRef`)
- Napisy i overlaye: czasy względem **timeline outputu**, nie źródłowego klipu

### 4.4 Warstwa kreatywności (`creativeMoments[]`, v2.1+)

Osobna tablica — techniki z katalogu `techniques/`:

```json
{
  "momentId": "cm_hook_zoom",
  "techniqueId": "zoom_punch_in",
  "outputId": "short_9x16",
  "outputStartSec": 0.5,
  "outputEndSec": 2.5,
  "params": { "factor": 1.08, "durationSec": 2.0 },
  "spatialRef": { "clipId": "clip01", "sceneId": "clip01_scene001", "anchorType": "face", "bbox": [0.1, 0.2, 0.5, 0.6] },
  "anchorWordId": "clip01_w0003",
  "retentionRole": "hook",
  "reason": "Punchline na najważniejszym zdaniu",
  "confidence": 0.85
}
```

Katalog technik definiuje parametry, constrainty i mapowanie na przyszły render (np. `zoom_punch_in` → crop/scale w FFmpeg). Reframe 9:16: `computeReframeCrop()` w `src/render/reframe.js`.

### 4.5 Plan audio (`audioMixPlan`, v2.3+)

```json
{
  "voiceTargetLufs": -16,
  "preWhisperNormalizeLufs": -18,
  "musicBed": {
    "trackId": "upbeat_vlog_01",
    "volumeDb": -20,
    "duckingDb": -14
  },
  "segments": [
    { "outputId": "main_16x9", "musicInSec": 0, "musicOutSec": 480, "duckUnderVoice": true }
  ]
}
```

`trackId` odnosi się do `assets/music/catalog.json`, nie do `clipId` batcha. Rozwiązanie ścieżki: `resolveRenderContext()` → `musicBed.trackFilePath` (`src/render/resolve-render-context.js`). Walidacja V23-02 (zakres LUFS), V23-03 (trackId + plik na dysku).

---

## 5. Artefakty analizy (wejście do reżyserii)

Director nie widzi surowego wideo — widzi skondensowane indeksy:

| Artefakt | Co daje reżyserowi |
|----------|-------------------|
| `00-scene-catalog.json` | Granice scen, `sourcePath` per clip, rozdzielczość |
| `01-words-<clip>.json` | WordIndex — słowa, timery, fillery (`wordId`) |
| `01b-audio-analysis-<clip>.json` | Beaty, energia, cisza, audio events |
| `02-keyframes-<clip>.json` | Klatki kluczowe (6/min A-roll, 12/min B-roll) |
| `05-timeline-index.json` | Sceny + słowa + wizja + detekcje w jednym indeksie |
| `05a-clip-registry.json` | Role klipów (A-roll / B-roll pool) |
| `05b-topic-index.json` | Tematy mowy → dopasowane sceny B-roll (score) |
| `05c-spatial-index.json` | Kotwice bbox (twarz/subject) pod zoom/reframe |
| `05d-audio-index.json` | LUFS, beaty, deadAirHints, rekomendacja muzyki |
| `06-abstract.json` | L1/L2/L3 — narracja i pacing |

Mapowanie `clipId` → plik źródłowy: `00-scene-catalog.json` → `clips[].sourcePath` + `fileName` (z ingest).

---

## 6. Czy to wystarcza do fazy montażu?

### 6.1 Werdykt

**Tak — do rozpoczęcia implementacji executora FFmpeg.** Plan montażowy jest kompletny na poziomie schematu v2.4, zwalidowany (V21–V24), a moduł `src/render/` dostarcza kontrakt wejścia (kontekst batcha, EDL, reframe, presety stylu). Szczegóły: [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md).

**Nie — do automatycznego „kliknij i masz gotowy film”.** Brakuje executora FFmpeg oraz kilku integracji opisanych w §6.3 (otwarte).

Ocena wewnętrzna projektu: pre-render **~9.5/10** jako generator planu (wcześniej ~9.1/10 przed remediacją luk W1–W2); wzrost dzięki schematowi v2.4, scaffoldowi renderu i gęstszej analizie B-roll. **10/10 niemożliwe bez działającego FFmpeg** ([`PRE_RENDER_AUDIT_FINAL.md`](./PRE_RENDER_AUDIT_FINAL.md)).

### 6.2 Co jest już gotowe pod montaż

| Element | Gotowość | Uwagi |
|---------|----------|-------|
| Timeline segmentów (A-roll, B-roll, J/L-cut) | ✅ | Semantyka w `EDITING_RECIPE_V2_SPEC.md` §7, §14 |
| Cross-clip audio + wideo | ✅ | `audioRef` / `videoRef` rozdzielone |
| Cięcia na poziomie słów | ✅ | `cuts[]` + `WordIndex` w batchu |
| Napisy word-by-word | ✅ częściowo | `subtitles` + `sourceClipId`; słowa w `01-words-*.json` |
| Overlaye tekstowe | ✅ częściowo | `textOverlays` + `renderStylePresets` / `style-presets.js` |
| Zabiegi kreatywne | ✅ plan | `creativeMoments` + katalog `techniques/` z parametrami |
| Muzyka bed + ducking | ✅ plan | `audioMixPlan` + `assets/music/` + `resolveRenderContext()` |
| Plan SFX | ✅ schema + helper | `sfxPlan[]` v2.4; `buildSfxPlanFromAudio()` — bez auto-wpięcia w pipeline |
| Color grade | ✅ schema | `colorGrade` v2.4; brak katalogu LUT na dysku |
| Oś czasu outputu | ✅ | `buildOutputTimeline()` w `src/lib/build-output-timeline.js` |
| EDL per output | ✅ scaffold | `buildRenderEdl()` w `src/render/build-render-edl.js` |
| Mapowanie clipId → plik | ✅ | `resolveRenderContext()` + `SceneCatalog.clips[].sourcePath` |
| Reframe 9:16 | ✅ algorytm | `computeReframeCrop()` w `src/render/reframe.js` |
| Walidacja przed renderem | ✅ | Zod + critic/fixer + golden recipes + V24 |

### 6.3 Luki — zamknięte vs nadal otwarte

Po remediacji opisanej w [`LUKI_PLAN_NAPRAWCZY.md`](./LUKI_PLAN_NAPRAWCZY.md):

#### Zamknięte w v2.4 (schema, analiza lub scaffold)

| Luka (dawniej) | Co istnieje w kodzie |
|----------------|----------------------|
| Brak `sfxPlan[]` | `SfxPlanEntrySchema`, pole `sfxPlan[]` w `EditRecipeV2Schema`; `buildSfxPlanFromAudio()` (`src/editorial/sfx-plan.js`); walidacja V24-01…03 |
| Brak color grade / LUT | `ColorGradeSchema` z `lutId`, `exposure`, `contrast`, `saturation` (`src/schemas/edit-recipe-v2.js`) |
| Presety napisów / overlayów | `RenderStylePresetsSchema` + `DEFAULT_RENDER_STYLE_PRESETS` (`src/render/style-presets.js`); V24-04 |
| `videoTransform.reframe` bez crop box | `computeReframeCrop()` — bbox z `spatialRef` / `05c-spatial-index.json` (`src/render/reframe.js`) |
| `audioPolicy: external` bez ścieżki | `resolveRenderContext()` → `musicBed.trackFilePath` via `resolveTrackById()` (`src/render/resolve-render-context.js`); V23-03 |
| Keyframes ~6/min na B-roll | `BROLL_MAX_FRAMES_PER_MIN = 12` dla `broll_pool` i klipów bez mowy (`src/pipeline/steps/keyframes.js`, `resolveMaxFramesPerMin()`) |
| Tolerancja sync B-roll (brak hintów) | `buildBrollSyncHints()` + `brief.brollSyncHints` w `buildDirectorBrief()` (`src/editorial/broll-sync-hints.js`, `src/agents/director.js`) |
| Brak kontraktu renderu | Moduł `src/render/`: `resolve-render-context.js`, `build-render-edl.js`, `reframe.js`, `style-presets.js` + testy; spec [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md) |
| LUFS poza zakresem | V23-02: `voiceTargetLufs` / `preWhisperNormalizeLufs` w [-24, -12] (`src/validators/recipe-v2.js`) |

#### Nadal otwarte

| Luka | Status | Uwagi |
|------|--------|-------|
| **Executor FFmpeg** | Brak | Scaffold EDL nie koduje wideo — patrz §7 i `RENDER_MODULE_SPEC.md` §FFmpeg mapping |
| `buildSfxPlanFromAudio()` → receptura | Nie wpięte | Helper i testy istnieją; director/pipeline nie wypełniają `sfxPlan[]` automatycznie |
| Katalog LUT (`assets/luts/`) | Brak plików | `colorGrade.lutId` w schemacie; rozwiązanie pliku LUT w rendererze do zrobienia |
| `transition` / `bridge` `segmentRole` | Deferred | Tylko `aroll` / `broll` w `SegmentRoleSchema`; przejścia przez `creativeMoments` |
| Frame-accurate sync B-roll | Wymaga renderu | Hinty poprawiają propozycję `videoInSec`; korekta klatkowa = faza FFmpeg (+ ewentualnie optical flow) |
| Stub vision/audio w `--fast` | Ograniczenie dev | Plan słabszy — live batch przed produkcją; bramki w `report --batch-id` |
| Brak live batch w CI | Dokumentacja | [`LIVE_BATCH_CHECKLIST.md`](./LIVE_BATCH_CHECKLIST.md) |
| Pixel-perfect animacje overlayów | Poza schematem | `renderStylePresets` daje font/pozycję/safe zone; animacje = decyzja renderera |

### 6.4 Remediacja przez analizę / technologie

Mapowanie każdej luki na rozwiązanie wdrożone w kodzie (szczegóły planu: [`LUKI_PLAN_NAPRAWCZY.md`](./LUKI_PLAN_NAPRAWCZY.md)):

| Luka | Remediacja | Pliki / artefakty |
|------|------------|-------------------|
| Gęstość keyframes B-roll | `maxFramesPerMin: 12` dla `broll_pool` i klipów bez mowy | `src/pipeline/steps/keyframes.js` (`resolveMaxFramesPerMin`, `BROLL_MAX_FRAMES_PER_MIN`) |
| `audioEvents` → plan SFX | Detekcja PANNs + tagi editorialne → `sfxPlan[]` | `src/editorial/sfx-plan.js` (`buildSfxPlanFromAudio`), wejście: `05d-audio-index.json`, `01b-audio-analysis-*.json` |
| `spatialIndex` → reframe 9:16 | Normalized crop box z bbox twarzy/subject | `src/render/reframe.js` (`computeReframeCrop`), wejście: `05c-spatial-index.json`, `creativeMoments[].spatialRef` |
| Sync B-roll z mową | Sugestie `videoInSec` z keyframes + L1 `keyMoments` | `src/editorial/broll-sync-hints.js` → `brief.brollSyncHints` w `src/agents/director.js` |
| `clipId` / `trackId` → ścieżki | Kontekst renderu z catalog + words + music | `src/render/resolve-render-context.js` |
| Timeline → EDL | Segmenty z `buildOutputTimeline()` + resolved paths | `src/render/build-render-edl.js` |
| Presety napisów/overlayów | Domyślne + override w recepturze | `src/render/style-presets.js`, `renderStylePresets` w schemacie v2.4 |
| Walidacja rozszerzona | V23-02/03 (audio mix), V24-01…05 (SFX, presety, budżet) | `src/validators/recipe-v2.js`, `recipe-v2-validator.test.js` |
| FFmpeg (cięcia, miks, eksport) | **Poza scope remediacji** | Przyszły executor — outline w `RENDER_MODULE_SPEC.md` |

### 6.5 Kontrakt renderera (zaimplementowany scaffold)

Wejścia modułu renderu (`src/render/`):

```
workDir/
  00-scene-catalog.json      # sourcePath per clipId
  01-words-*.json            # napisy
  09-edit-recipe-final.json  # plan (EditRecipe v2.0–2.4)
  assets/music/<file>        # muzyka z catalog.json (via resolveRenderContext)
inbox/ lub ścieżki z catalog  # surowe wideo
```

Kroki (scaffold + przyszły FFmpeg, z [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md)):

1. `context = resolveRenderContext(workDir, recipe)`
2. `edl = buildRenderEdl(output, recipe, context)` dla każdego `outputs[]`
3. Dla każdego segmentu EDL: trim wideo/audio według `videoInSec`/`audioInSec` i polityki `audioPolicy`
4. Zastosuj `cuts[]` na osi audio (word timestamps z `context.wordIndexes`)
5. Złóż timeline z J/L-cut (`from_prev`/`from_next`, `overlapSec`)
6. `computeReframeCrop()` gdy `output.format === "9:16"`
7. Nałóż `creativeMoments`, napisy (`renderStylePresets` + `DEFAULT_RENDER_STYLE_PRESETS`)
8. Miksuj wg `audioMixPlan` + `sfxPlan[]`
9. Eksportuj per `format` → MP4

---

## 7. Rekomendowany następny krok

1. **Zamknij pre-render na live materiale** — `npm run full -- --input ./inbox/...` + `report --batch-id` (bramki jakości).
2. **Wykorzystaj scaffold renderu** — `resolveRenderContext()` + `buildRenderEdl()` (`src/render/`, testy: `npm test -- src/render/`). Spec: [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md).
3. **Zbuduj minimalny executor FFmpeg** — jeden output, tylko `segmentRole: aroll`, `from_video_ref`, bez creativeMoments; EDL jako wejście.
4. **Rozszerzaj iteracyjnie** — B-roll cross-clip → cuts/word → napisy → `computeReframeCrop` → creativeMoments → `audioMixPlan` → `sfxPlan`.
5. **Opcjonalnie włącz auto-SFX** — wywołaj `buildSfxPlanFromAudio(audioIndex, { perClipAnalysis })` przed directorem lub w post-processie receptury.
6. **Trzymaj EditRecipe jako kontrakt** — renderer czyta `09-edit-recipe-final.json`, nie duplikuje logiki directora.

---

## 8. Szybka ściągawka formatów

| Agent | Format odpowiedzi | Plik artefaktu |
|-------|-------------------|----------------|
| Summarizer | `AbstractionBundle` (L1/L2/L3) | `06-abstract.json` |
| Director | `EditRecipeV2` v2.0–2.4 | `07-edit-recipe-draft.json` |
| Critic | `ReviewResult` v1.0 | `08-review.json` |
| Fixer | `EditRecipeV2` (poprawiony) | → `09-edit-recipe-final.json` |
| Walidator | issues[] (kody SR, V21–V24) | wewnątrz review + testy |
| Render (scaffold) | EDL JSON per output | — (w pamięci / przyszły artefakt) |

**Format reżyserii** = `EditRecipeV2` z timeline segmentów + opcjonalnie `creativeMoments`, `audioMixPlan`, `sfxPlan`, `colorGrade`, `renderStylePresets`.

**Gotowość do montażu** = plan **tak** (v2.4 + walidacja), kontrakt renderu **tak** (`src/render/`), executor FFmpeg **nie** — startuj od MVP na EDL z [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md).
