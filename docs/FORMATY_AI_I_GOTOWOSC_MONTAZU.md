# Formaty odpowiedzi AI i gotowość do montażu

> Last updated: 2026-06-26  
> Cel: jedno miejsce odpowiadające na pytania: *w jakim formacie odpowiada AI, w jakim reżyseruje, czy to wystarcza do fazy montażu?*

Powiązane: [`README.md`](../README.md), [`PRE_RENDER_PIPELINE.md`](./PRE_RENDER_PIPELINE.md), [`EDITING_RECIPE_V2_SPEC.md`](./EDITING_RECIPE_V2_SPEC.md), [`LUKI_PLAN_NAPRAWCZY.md`](./LUKI_PLAN_NAPRAWCZY.md), [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md)

---

## 1. Co robi ten projekt (a czego nie)

| Faza | Status |
|------|--------|
| Analiza materiału (Whisper, wizja, audio, indeksy) | **Gotowe** — 14 kroków pipeline |
| Reżyseria AI (plan montażu) | **Gotowe** — director → critic → fixer |
| Walidacja planu (Zod + reguły V21/V22/V23/V24) | **Gotowe** |
| Kontrakt renderu (EDL, kontekst, reframe, presety) | **Gotowe** — `src/render/` |
| **Render wideo** (cięcia FFmpeg, overlay, miks, eksport MP4) | **Zaimplementowane** — `node src/cli.js render` (partial crossfade gdy nie wszystkie joiny) |

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
    → resolveRenderContext() + buildRenderEdl()   [src/render/]
    → executeRender() — FFmpeg executor → MP4 w renders/
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

**Super Director routing:** gdy łączny czas batcha **> 600 s** lub jest **> 1 segment L2**, krok `direct` używa Super Director (`prompts/v2/super-director.md`) → segment directors → `mergeSegmentRecipes`. Krótsze batchy (≤ 600 s i jeden segment L2) omijają ten krok. Implementacja: `shouldUseSuperDirector()` w `src/lib/segment-catalog.js`, `runSuperDirectorDirectPath()` w `src/pipeline/steps/agents.js`.

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
| `audioMixPlan` | (v2.3+) LUFS, muzyka bed, ducking — plan w recepturze; miks w rendererze |
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

**Helper pre-render:** `buildSfxPlanFromAudio()` w `src/editorial/sfx-plan.js` buduje propozycję z `05d-audio-index.json` i `01b-audio-analysis-<clip>.json` (`audioEvents`, `editorialTags`). Po kroku **direct** (i po fixerze w review) pipeline automatycznie wypełnia `sfxPlan[]` przez `enrichRecipeSfxPlan()` w `src/pipeline/steps/agents.js` (gęstość V24-06: max 1 wpis / 90s na main — walidator ostrzega przy przekroczeniu).

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

Pole `lutId` odnosi się do `assets/luts/catalog.json`. Renderer (`color-grade.js`) stosuje `eq` oraz opcjonalnie `lut3d` gdy plik `.cube` istnieje obok katalogu; brak pliku → tylko `eq` lub pominięcie passu.

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
  "videoTransform": { "reframe": "center", "speed": 1, "speedMode": "video_audio" },
  "sourceVolumeDb": -3,
  "intent": "Opis intencji dla montażysty / review"
}
```

**Pola prędkości i głośności:**

- `videoTransform.speed` — mnożnik tempa wideo (1 = normalnie); renderer stosuje `setpts=PTS/speed`
- `videoTransform.speedMode` — `video_audio` (domyślnie: wideo + audio przyspieszone `atempo`) lub `video_only` (tylko wideo; audio bez zmiany tempa — np. B-roll pod narrację)
- `sourceVolumeDb` — korekta głośności źródła w dB (np. `-6` = cichsze); filtr `volume` w pass segmentu

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

**Tak — pipeline end-to-end działa:** analiza → EditRecipe → `node src/cli.js render` → MP4. Moduł [`src/render/`](src/render/) realizuje timeline, B-roll, 9:16 reframe, ASS, overlaye, creativeMoments, audioMixPlan. Szczegóły: [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md).

**Ograniczenia:** J/L-cut overlap (fallback concat), frame-accurate sync B-roll wymaga ręcznej korekty lub przyszłego optical flow.

Ocena wewnętrzna projektu: pre-render **~9.5/10** jako generator planu; **render FFmpeg zaimplementowany** (W4) — pełny eksport MP4 z receptury v2.4. Szczegóły executor: [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md).

### 6.2 Co jest już gotowe pod montaż

| Element | Gotowość | Uwagi |
|---------|----------|-------|
| Timeline segmentów (A-roll, B-roll, J/L-cut) | ✅ executor | Semantyka w `EDITING_RECIPE_V2_SPEC.md` §7, §14 |
| Cross-clip audio + wideo | ✅ executor | `audioRef` / `videoRef` rozdzielone |
| Cięcia na poziomie słów | ✅ executor | `cuts[]` + `WordIndex` w batchu (video+audio splice, `audio-cuts.js`) |
| Napisy word-by-word | ✅ executor | ASS burn-in (`ass-subtitles.js`) |
| Overlaye tekstowe | ✅ executor | `textOverlays` + `ffmpeg-graphics.js` |
| Zabiegi kreatywne | ✅ executor | `creativeMoments` + `technique-to-ffmpeg.js` (m.in. match_cut, whip_pan best-effort) |
| Muzyka bed + ducking | ✅ executor | `audioMixPlan` + `assets/music/` + `audio-mix.js` |
| Plan SFX | ✅ executor | `sfxPlan[]` + `assets/sfx/` (`resolveSfxPath`) |
| Color grade | ✅ executor | `colorGrade` + `assets/luts/catalog.json` + opcjonalne `.cube` |
| Oś czasu outputu | ✅ | `buildOutputTimeline()` w `src/lib/build-output-timeline.js` |
| EDL per output | ✅ executor | `buildRenderEdl()` + `enrich-render-edl.js` |
| Mapowanie clipId → plik | ✅ executor | `resolveRenderContext()` + `SceneCatalog.clips[].sourcePath` |
| Reframe 9:16 | ✅ executor | `ffmpeg-reframe.js` + `computeReframeCrop()` |
| Walidacja przed renderem | ✅ | Zod + critic/fixer + golden recipes + V24 |

### 6.3 Luki — zamknięte vs nadal otwarte

Po remediacji opisanej w [`LUKI_PLAN_NAPRAWCZY.md`](./LUKI_PLAN_NAPRAWCZY.md):

#### Zamknięte w v2.4 (schema, analiza lub scaffold)

| Luka (dawniej) | Co istnieje w kodzie |
|----------------|----------------------|
| Brak `sfxPlan[]` | `SfxPlanEntrySchema`, pole `sfxPlan[]` w `EditRecipeV2Schema`; `buildSfxPlanFromAudio()` (`src/editorial/sfx-plan.js`); walidacja V24-01…03 |
| Brak color grade / LUT | `ColorGradeSchema` + `assets/luts/catalog.json`; `color-grade.js` (`lut3d` gdy `.cube` istnieje) |
| Presety napisów / overlayów | `RenderStylePresetsSchema` + `DEFAULT_RENDER_STYLE_PRESETS` (`src/render/style-presets.js`); V24-04 |
| `videoTransform.reframe` bez crop box | `computeReframeCrop()` — bbox z `spatialRef` / `05c-spatial-index.json` (`src/render/reframe.js`) |
| `audioPolicy: external` bez ścieżki | `resolveRenderContext()` → `musicBed.trackFilePath` via `resolveTrackById()` (`src/render/resolve-render-context.js`); V23-03 |
| Keyframes ~6/min na B-roll | `BROLL_MAX_FRAMES_PER_MIN = 12` dla `broll_pool` i klipów bez mowy (`src/pipeline/steps/keyframes.js`, `resolveMaxFramesPerMin()`) |
| Tolerancja sync B-roll (brak hintów) | `buildBrollSyncHints()` + `brief.brollSyncHints` w `buildDirectorBrief()` (`src/editorial/broll-sync-hints.js`, `src/agents/director.js`) |
| Brak kontraktu renderu | Moduł `src/render/` + **executor FFmpeg** (`execute-render.js`, CLI `render`); spec [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md) |
| LUFS poza zakresem | V23-02: `voiceTargetLufs` / `preWhisperNormalizeLufs` w [-24, -12] (`src/validators/recipe-v2.js`) |
| Post-director enrich SFX | `enrichRecipeSfxPlan()` w `src/pipeline/steps/agents.js` (post-direct + po fixerze) |
| Post-director enrich retention beats | `enrichRecipeRetentionBeats()` — auto `enrich_beat_*` gdy director pominął beaty (`src/editorial/shorts-retention.js`) |
| Post-director enrich chapter cards | `enrichRecipeChapterCards()` — `chapter_card` textOverlays z L2 (`src/editorial/chapter-hints.js`) |
| Cold-open segment hint | `buildColdOpenSegmentHint()` → `brief.coldOpenSegmentHint` w director brief |

#### Nadal otwarte

| Luka | Status | Uwagi |
|------|--------|-------|
| Pliki LUT poza `neutral_vlog.cube` | Opcjonalne | `warm_golden_hour.cube` w `assets/luts/` (stub 2×2); renderer stosuje `lut3d` gdy plik istnieje |
| J/L-cut frame-accurate | Best-effort | `audio-jlcut.js` — overlap uproszczony; pełna klatka = przyszła iteracja |
| `transition` / `bridge` `segmentRole` | Deferred | Tylko `aroll` / `broll` w `SegmentRoleSchema`; przejścia przez `creativeMoments` |
| `crossfade` częściowy | Warning only | Gdy częściowy wzorzec joinów lub J/L overlap |
| `jump_cut` | ✅ best-effort | Impuls brightness/contrast w creative pass (nie cięcie timeline) |
| `silence_beat` | ✅ pass audio | Dip głosu w `audio-mix.js` gdy `audioMixPlan` |
| `music_swell` / `music_drop` | ✅ pass audio | Gdy `audioMixPlan.musicBed` — volume automation w `audio-mix.js` |
| Frame-accurate sync B-roll | Wymaga korekty | Hinty poprawiają propozycję `videoInSec`; korekta klatkowa = optical flow (przyszłość) |
| Brak live batch w CI | Dokumentacja | [`LIVE_BATCH_CHECKLIST.md`](./LIVE_BATCH_CHECKLIST.md) |
| Pixel-perfect animacje overlayów | Poza schematem | `renderStylePresets` daje font/pozycję/safe zone; animacje = decyzja renderera |

### 6.4 Remediacja przez analizę / technologie

Mapowanie każdej luki na rozwiązanie wdrożone w kodzie (szczegóły planu: [`LUKI_PLAN_NAPRAWCZY.md`](./LUKI_PLAN_NAPRAWCZY.md)):

| Luka | Remediacja | Pliki / artefakty |
|------|------------|-------------------|
| Gęstość keyframes B-roll | `maxFramesPerMin: 12` dla `broll_pool` i klipów bez mowy | `src/pipeline/steps/keyframes.js` (`resolveMaxFramesPerMin`, `BROLL_MAX_FRAMES_PER_MIN`) |
| `audioEvents` → plan SFX | Detekcja PANNs + tagi editorialne → `sfxPlan[]` | `enrichRecipeSfxPlan()` post-direct (`src/editorial/sfx-plan.js`, `agents.js`); V24-06: max 1/90s na main |
| `spatialIndex` → reframe 9:16 | Normalized crop box z bbox twarzy/subject | `src/render/reframe.js` (`computeReframeCrop`), wejście: `05c-spatial-index.json`, `creativeMoments[].spatialRef` |
| Sync B-roll z mową | Sugestie `videoInSec` z keyframes + L1 `keyMoments` | `src/editorial/broll-sync-hints.js` → `brief.brollSyncHints` w `src/agents/director.js` |
| `clipId` / `trackId` → ścieżki | Kontekst renderu z catalog + words + music | `src/render/resolve-render-context.js` |
| Timeline → EDL | Segmenty z `buildOutputTimeline()` + resolved paths | `src/render/build-render-edl.js` |
| Presety napisów/overlayów | Domyślne + override w recepturze | `src/render/style-presets.js`, `renderStylePresets` w schemacie v2.4 |
| Walidacja rozszerzona | V23-02/03 (audio mix), V24-01…05 (SFX, presety, budżet) | `src/validators/recipe-v2.js`, `recipe-v2-validator.test.js` |
| FFmpeg (cięcia, miks, eksport) | **Executor FFmpeg** | `src/render/execute-render.js`, `npm run render -- --batch-id <id>` |

### 6.5 Kontrakt renderera (zaimplementowany executor)

Wejścia modułu renderu (`src/render/`):

```
workDir/
  00-scene-catalog.json      # sourcePath per clipId
  01-words-*.json            # napisy
  05c-spatial-index.json    # kotwice spatial (reframe 9:16)
  09-edit-recipe-final.json  # plan (EditRecipe v2.0–2.4)
  assets/music/<file>        # muzyka z catalog.json (via resolveRenderContext)
inbox/ lub ścieżki z catalog  # surowe wideo
```

Kroki (executor FFmpeg, zgodnie z [`RENDER_MODULE_SPEC.md`](./RENDER_MODULE_SPEC.md) i `execute-render.js`):

1. `context = resolveRenderContext(workDir, recipe)` — clip paths, word indexes, music bed, spatialIndex
2. `edl = buildRenderEdl(output, recipe, context)` dla każdego `outputs[]`
3. **Segment pass** — dla każdego segmentu EDL: trim wideo/audio według `videoInSec`/`audioInSec` i polityki `audioPolicy`; zastosuj `cuts[]` na **obu osiach** (video+audio splice via `audio-cuts.js`, word timestamps z `context.wordIndexes`); reframe 9:16 (`computeReframeCrop()`) gdy `output.format === "9:16"`; segmenty J/L (`from_prev`/`from_next`) renderują wideo-only (`-an`) — audio sąsiada składane w pass concat
4. **Concat** — złóż segmenty → `concat.mp4`: J/L-cut carry-forward (`audio-jlcut.js`); boundary `crossfade` (2 seg lub 3+ gdy jeden join lub wszystkie joiny mają crossfade; inaczej `CROSSFADE_NOT_APPLIED`); `cut_on_beat` snap + realign EDL
5. **Creative** — `creativeMoments` (zoom, ken burns, …); boundary crossfade pominięty gdy już zastosowany w concat
6. **Napisy** — ASS burn-in gdy `subtitles.policy !== off` (`renderStylePresets` + `DEFAULT_RENDER_STYLE_PRESETS`)
7. **Graphics** — `textOverlays` (drawtext)
8. **Audio mix** — `audioMixPlan` (loudnorm voice + music bed ducking `duckingDb`) + `sfxPlan[]`; manifest `audioMixApplied: true` gdy pass faktycznie uruchamia FFmpeg
9. **Color grade** — `colorGrade` (eq / lut3d) i eksport per `format` → `renders/<outputId>_<format>.mp4`
10. Manifest → `13-render-manifest.json`

---

## 7. Rekomendowany następny krok

1. **Zamknij pre-render na live materiale** — `npm run full -- --input ./inbox/...` + `report --batch-id` (bramki jakości).
2. **Renderuj MP4 z receptury** — `npm run render -- --batch-id <id>` (profile `draft` / `production`). Testy: `npm test -- src/render/`, `npm run test:e2e`.
3. **Rozszerzaj iteracyjnie** — J/L-cut frame-accurate, `crossfade` 3+ seg (`cut_on_beat` concat snap, `jump_cut` pulse, `silence_beat` audio dip — wdrożone W4.11–W4.12).
4. **Opcjonalnie włącz auto-SFX** — wywołaj `buildSfxPlanFromAudio(audioIndex, { perClipAnalysis })` przed directorem lub w post-processie receptury; pełny katalog SFX + voiceover: [`REQUIREMENTS_SFX_LIBRARY_AND_VOICEOVER.md`](./REQUIREMENTS_SFX_LIBRARY_AND_VOICEOVER.md).
5. **Trzymaj EditRecipe jako kontrakt** — renderer czyta `09-edit-recipe-final.json`, nie duplikuje logiki directora.

---

## 8. Szybka ściągawka formatów

| Agent | Format odpowiedzi | Plik artefaktu |
|-------|-------------------|----------------|
| Summarizer | `AbstractionBundle` (L1/L2/L3) | `06-abstract.json` |
| Director | `EditRecipeV2` v2.0–2.4 | `07-edit-recipe-draft.json` |
| Critic | `ReviewResult` v1.0 | `08-review.json` |
| Fixer | `EditRecipeV2` (poprawiony) | → `09-edit-recipe-final.json` |
| Walidator | issues[] (kody SR, V21–V24) | wewnątrz review + testy |
| Render (executor) | MP4 + `13-render-manifest.json` | `renders/*.mp4`, `13-render-manifest.json` |

**Format reżyserii** = `EditRecipeV2` z timeline segmentów + opcjonalnie `creativeMoments`, `audioMixPlan`, `sfxPlan`, `colorGrade`, `renderStylePresets`.

**Gotowość do montażu** = plan **tak** (v2.4 + walidacja), kontrakt renderu **tak** (`src/render/`), executor FFmpeg **tak** — `node src/cli.js render --batch-id <id>` (z ostrzeżeniami dla technik deferred).

### Roadmap W4 (renderer FFmpeg)

| Faza | Status | Uwagi |
|------|--------|-------|
| W4 core (A-roll, B-roll, concat, CLI) | ✅ done | `execute-render.js`, `13-render-manifest.json` |
| W4 shorts (9:16, ASS, overlaye) | ✅ done | `ffmpeg-reframe.js`, `ass-subtitles.js` |
| W4 creative + J/L-cut | ✅ done (caveats) | `technique-to-ffmpeg.js`; J/L-cut best-effort |
| W4 audio (mix, sfx, color) | ✅ done | `audio-mix.js`, `sfxPlan`, `color-grade.js` + `assets/sfx/`, `assets/luts/` |
| W4 deferred | Otwarte | Frame-accurate J/L-cut; crossfade częściowy (nie wszystkie joiny) |
