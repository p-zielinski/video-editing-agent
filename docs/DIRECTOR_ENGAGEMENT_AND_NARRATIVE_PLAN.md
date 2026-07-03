# Plan rozwoju reżysera: retencja, narracja, render i pipeline

> **Utworzono:** 2026-07-03  
> **Status:** plan analityczny (niezaimplementowany w całości)  
> **Źródło:** analiza wieloetapowa (subagenty: analiza → implementacja → Bugbot → poprawki) + audyt retencji/narracji/renderu

Ten dokument zbiera **wszystkie obserwacje** z prac nad projektem `video-editing-agent`: co już działa, co zostało zaimplementowane w sesji 2026-07-03, luki architektoniczne, porównania opcji (A vs B) i priorytetyzowany roadmap.

---

## Spis treści

1. [Kontekst i cele](#1-kontekst-i-cele)
2. [Stan po implementacji 2026-07-03](#2-stan-po-implementacji-2026-07-03)
3. [Architektura pipeline (skrót)](#3-architektura-pipeline-skrot)
4. [Zaimplementowane funkcje (sesja)](#4-zaimplementowane-funkcje-sesja)
5. [Pionowe wideo w poziomym filmie (FaceTime)](#5-pionowe-wideo-w-poziomym-filmie-facetime)
6. [Częściowy voice-over (MP3/WAV/M4A)](#6-częściowy-voice-over-mp3wavm4a)
7. [Prędkość, głośność i audio mix](#7-prędkość-głośność-i-audio-mix)
8. [TwelveLabs (opisy wideo)](#8-twelvelabs-opisy-wideo)
9. [Super Director (hierarchia reżyserów)](#9-super-director-hierarchia-reżyserów)
10. [Katalog technik i gramatyka retencji](#10-katalog-technik-i-gramatyka-retencji)
11. [Luka: reżyser vs renderer](#11-luka-reżyser-vs-renderer)
12. [Luka: retencja vs narracja](#12-luka-retencja-vs-narracja)
13. [Enrichery deterministyczne](#13-enrichery-deterministyczne)
14. [Walidatory V21–V25 (retencja-relevant)](#14-walidatory-v21v25-retencja-relevant)
15. [Shorts vs main vlog — asymetria](#15-shorts-vs-main-vlog--asymetria)
16. [Kontrolki artystyczne — braki](#16-kontrolki-artystyczne--braki)
17. [Model „sztuki filmu do internetu”](#17-model-sztuki-filmu-do-internetu)
18. [Porównania A vs B](#18-porównania-a-vs-b)
19. [Trzy podejścia do guardrails narracji](#19-trzy-podejścia-do-guardrails-narracji)
20. [Ranking rekomendacji (P0–P3)](#20-ranking-rekomendacji-p0p3)
21. [Plan fazowy implementacji](#21-plan-fazowy-implementacji)
22. [Czego NIE robić (antywzorce)](#22-czego-nie-robić-antywzorce)
23. [Dokumentacja — co zaktualizowano / co zostało](#23-dokumentacja--co-zaktualizowano--co-zostało)
24. [Commity i weryfikacja](#24-commity-i-weryfikacja)
25. [Otwarte pytania](#25-otwarte-pytania)
26. [Mapa plików](#26-mapa-plików)

---

## 1. Kontekst i cele

### Problemy użytkownika (oryginalne)

1. **Reżyser:** przyspieszanie/spowalnianie, sterowanie głośnością, muzyka zamiast obniżania głosu przy speed-up.
2. **Analiza wideo:** TwelveLabs API vs lokalny Qwen na keyframes — lepsze opisy → lepsze decyzje montażowe.
3. **Architektura reżysera:** wzorzec docs-assistant (router → max 10 dokumentów → generator) — reżyser na segment 5–10 min, super-reżyser na długie treści, unikanie jednego modelu na cały batch.
4. **Pionowe wideo w 16:9:** krótkie wstawki FaceTime / nagranie ekranu telefonu w długim filmie YouTube.
5. **Częściowy VO:** plik MP3/WAV/M4A jako narracja tylko na fragmenty filmu (nie cały film VO).
6. **Retencja vs historia:** co jeszcze wzmocni oglądalność bez zabijania opowieści — „sztuka dobrych filmów do internetu”.

### Zasada projektowa

> Retencja (beaty, hooki, SFX) musi być **fazowa i ograniczona**, nie globalna i mechaniczna. Narracja jest dziś „miękka” (tekst L3); retencja jest „twarda” (walidatory + enrichery).

---

## 2. Stan po implementacji 2026-07-03

### Commity lokalne (push wymaga poświadczeń GitHub)

| Commit | Opis |
|--------|------|
| `9e47d79` | Speed + sourceVolumeDb, TwelveLabs scaffold, Super Director |
| `08092c6` | fitMode pillarbox/fill, partial VO fixes, mediaType, audio_only keyframes |

### Testy

- **1030+ pass**, 0 fail, 2 skip (`npm test`)
- Bugbot końcowy: **clean** (po serii poprawek merge/speed/twelvelabs)

### Handoff agenta

- `~/.cursor/work/director-speed-vision-hierarchy.md` — status sesji implementacyjnej

---

## 3. Architektura pipeline (skrót)

**14 kroków analizy + direct + review** (przed opcjonalnym `thumbnails`):

```
ingest → transcribe → audio_analysis → keyframes → twelvelabs → vision → objects
→ index → clip_profile → abstract → topic_index → spatial_index → direct → review
```

**Warstwy danych → brief reżysera:**

| Artefakt | Rola |
|----------|------|
| `05-timeline-index.json` | sceneMap, transcriptExcerpts, aspectRatio |
| `06-abstract.json` (L1/L2/L3) | narracja, segmenty ~5–10 min |
| `05a-clip-registry.json` | role klipów, narration_track |
| `05b-topic-index.json` | B-roll pod temat mowy |
| `05c-spatial-index.json` | reframe 9:16, kotwice |
| `05d-audio-index.json` | beaty, deadAirHints, musicBed |
| `03b-twelvelabs-*.json` | momenty/chapters (stub domyślnie) |

**Direct step — dwa tryby:**

```
IF duration ≤ 600s AND L2.length ≤ 1:
  runDirector → directorDrillDown (legacy)
ELSE:
  runSuperDirector → runSegmentDirector × N → mergeSegmentRecipes
```

---

## 4. Zaimplementowane funkcje (sesja)

### 4.1 Speed i głośność źródła

| Element | Plik | Stan |
|---------|------|------|
| `videoTransform.speed` (0.25–4) | `edit-recipe-v2.js` | ✅ schema |
| `speedMode: video_audio \| video_only` | `edit-recipe-v2.js` | ✅ |
| `sourceVolumeDb` (-60…+12 dB) | `edit-recipe-v2.js` | ✅ |
| `atempo` + `setpts` | `ffmpeg-segment.js`, `speed-transform.js` | ✅ |
| `video_only` + tpad gdy wideo krótsze od audio | `speed-transform.js` | ✅ |
| Timeline duration / speed | `build-output-timeline.js` | ✅ |
| Prompt directora | `prompts/v2/director.md` | ✅ |

**Luki pozostałe:** brak e2e FFmpeg render testu dla speed; brak validator warning V25-SPEED na `from_prev`.

### 4.2 TwelveLabs scaffold

| Element | Stan |
|---------|------|
| Krok `twelvelabs` po keyframes | ✅ |
| Artefakt `03b-twelvelabs-<clipId>.json` | ✅ stub |
| `--no-twelvelabs`, `--twelvelabs-stub`, `--twelvelabs-live` | ✅ |
| Live API | ❌ niezaimplementowany; fallback do stub z warning |
| Merge w topic-index | ✅ `twelvelabs-merge.js` |
| topic_index deps na 03b | ✅ `artifact-deps.js` |

### 4.3 Super Director

| Element | Plik | Stan |
|---------|------|------|
| Segment catalog (L2 cards) | `segment-catalog.js` | ✅ |
| Router | `super-director.js`, `prompts/v2/super-director.md` | ✅ |
| Segment director | `segment-director.js` | ✅ |
| Merge receptur | `recipe-merge.js` | ✅ (12 testów) |
| Branch w agents.js | `shouldUseSuperDirector` | ✅ |
| excludedClips enforcement | brief + filter w merge | ✅ |
| sfxPlan per-output offsets | `recipe-merge.js` | ✅ |
| textOverlays retime | `recipe-merge.js` | ✅ |

**Bugi naprawione w merge (sesja):**

- Mapowanie partials po `segmentId`, nie indeksie
- Union outputs z wszystkich partials (short nie ginie)
- Partials poza `segmentOrder` dopinane z picks
- SFX offsets z excluded clips w stitch

**Luki:** brak super-critic cross-segment; unpicked L2 segments — brak „bridge” pass; mini-day używa legacy (1 L2 runtime).

### 4.4 Pionowe wstawki + partial VO (sesja 2)

| Element | Stan |
|---------|------|
| `fitMode: pillarbox \| fill` | ✅ schema + render |
| Pillarbox domyślny dla 9:16→16:9 | ✅ scale+pad |
| fill tylko przy `fitMode: "fill"` (nie `reframe: center`) | ✅ poprawka Bugbot |
| V25-AR: brak warning dla vertical broll w 16:9 | ✅ |
| `mediaType` preserved po scene detect | ✅ orchestrator |
| keyframes skip dla audio_only | ✅ |
| VO-03 w prompcie directora | ✅ |
| `hasSeparateNarration` w briefie | ✅ |
| ingest .mp3/.m4a | ✅ (testy) |

---

## 5. Pionowe wideo w poziomym filmie (FaceTime)

### Co działa end-to-end

1. Ingest: `computeAspectRatio()` → `"9:16"` dla pionowych klipów (`scene-catalog.js`).
2. Renderer 16:9 **bez** `fitMode`: `scale` + `pad` → pillarbox (pionowy pas na środku, czarne boki).
3. Reżyser widzi `aspectRatio` w `sceneMap`, `aspectMix`, `clipAspectById`.

### Zalecany wzorzec receptury

```json
{
  "segmentRole": "broll",
  "videoRef": { "clipId": "clip_facetime", "sceneId": "..." },
  "audioRef": { "clipId": "clip_facetime", "sceneId": "..." },
  "videoTransform": { "fitMode": "pillarbox" },
  "intent": "Wstawka FaceTime — krótki fragment rozmowy (2–15 s)"
}
```

### Zasady dla directora

| Zasada | Powód |
|--------|-------|
| `segmentRole: "broll"`, nie A-roll | V25-AR-02 ostrzega vertical A-roll w main |
| 2–15 s, nie cały main z pionu | Historia + proporcje |
| `fitMode: "pillarbox"` lub brak transformu | Domyślny wygląd FaceTime |
| `fitMode: "fill"` tylko świadomie | Crop góra/dół — rzadkie dla rozmów |
| **Unikać** `reframe: face/subject` w 16:9 | Wymusza crop, nie pillarbox |
| `reframe: center` **nie** zmienia renderu na 16:9 | Tylko fitMode fill robi crop |

### Luki wizualne (P2 render)

- Pillarbox = **czarne** pasy (`pad`), brak rozmytego tła (TikTok/Reels style).
- Brak „phone frame” / rounded corners / drop shadow.
- `fitMode` nie ma `blur_background` — propozycja na przyszłość.

### Semantyka validatorów

| Kod | Kiedy |
|-----|-------|
| V25-AR-02 | vertical **A-roll** w main 16:9 bez transform |
| V25-AR-01 | inne mismatch aspect (suppressed dla vertical **broll** w 16:9) |
| `fitMode` pillarbox/fill | intentional — brak warning |

---

## 6. Częściowy voice-over (MP3/WAV/M4A)

### Co działa (VO-01, VO-02, częściowo VO-03)

| Warstwa | Dowód |
|---------|-------|
| Ingest | `.wav`, `.mp3`, `.m4a` → `mediaType: audio_only` |
| Transcribe | Whisper na pliku audio |
| clip-profile | `narration_track` gdy audio_only + hasSpeech |
| Segmenty | `from_audio_ref` + B-roll videoRef |
| Renderer | lavfi black + osobna ścieżka audio; cross-clip mux |
| Walidacja | V25-VO-01, V25-VO-02 |
| Fixture | `fixtures/batches/voiceover-day/` |
| E2E | `tests/e2e/render-voiceover.test.js` |

### Wzorzec częściowego VO (VO-03)

```
inbox/
  01_talking_head.MOV   # intro A-roll
  02_broll_city.MOV     # wizualia
  03_narration.mp3      # narracja (fragmenty)
```

Timeline:

1. `seg_intro` — `aroll`, `from_video_ref`, subtitles → klip A-roll
2. `seg_vo_01` — `broll`, wideo B-roll, `audioRef` → clip03, `from_audio_ref`, subtitles → clip03
3. (opcjonalnie) powrót do A-roll `from_video_ref`

**MP3 = WAV funkcjonalnie** — ten sam pipeline; MP3 re-enkodowany przy transkrypcji.

### Naprawione bugi pipeline (P0)

1. **`mediaType` gubione** po `detectScenesForCatalog` w orchestratorze → naprawione.
2. **Keyframes na audio_only** → pusty artefakt, bez crashu FFmpeg.

### Luki pozostałe

| Luka | Priorytet |
|------|-----------|
| Brak fixture `voiceover-mixed-day` (intro A-roll + VO) | P1 |
| Brak E2E render mixed timeline | P1 |
| V25-VO-03: brak wymuszenia `narration_track` na audioRef | P3 |
| `hasSeparateNarration` tylko w briefie — słaba egzekucja | P2 |
| Topic index miesza tematy A-roll + narracji | P3 |
| Super-director prompt bez sekcji VO | P3 |
| VO wideo (talking head) z ignorowanym obrazem — działa przez `from_audio_ref` | OK |

### Dokumentacja

- `docs/REQUIREMENTS_SFX_LIBRARY_AND_VOICEOVER.md` — VO-G1…G8 większość ✅
- `README.md` — sekcja częściowy VO dodana

---

## 7. Prędkość, głośność i audio mix

### Director może dziś

| Kontrola | Pole | Render |
|----------|------|--------|
| Przyspieszenie A-roll | `speed` + `video_audio` | atempo + setpts |
| Przyspieszenie B-roll pod narracją | `speed` + `video_only` | setpts + tpad |
| Gain segmentu | `sourceVolumeDb` | volume filter |
| Muzyka bed | `audioMixPlan.musicBed` | sidechain ducking |
| Dip dramatyczny | `silence_beat` creativeMoment | voice dip |
| SFX | `sfxPlan[]` | adelay + volume |

### Kombinacja speed + muzyka

- `audioMixPlan` + `duckUnderVoice` — muzyka pod głosem; **nie** trzeba obniżać źródła przy speed-up.
- Nie ustawiać `audioPolicy: external` na speech + music bed jednocześnie (double music risk).

---

## 8. TwelveLabs (opisy wideo)

### Decyzja architektoniczna

**Hybrid supplement (Option B)** — nie zastępuje Qwen/Florence/keyframes.

| Warstwa | Rola |
|---------|------|
| Qwen + keyframes | Lokalne, scene-anchored, offline |
| Florence | bbox, spatial index |
| TwelveLabs | Moment retrieval, chapters, clip summary dla B-roll |

### Gating proponowany

- TL dla: `broll_pool`, `hasSpeech=false`, scen z &lt;2 captionami
- Skip: `--no-twelvelabs`, brak API key, CI stub

### Stan implementacji

- Scaffold + stub ✅
- Pegasus/Marengo live ❌
- Prototyp pierwszy: `fixtures/batches/mini-day` clip B-roll

### Koszt orientacyjny

~$0.5–1.5 / batch 15 min vs 15–60 min lokalnego GPU.

---

## 9. Super Director (hierarchia reżyserów)

### Wzorzec docs-assistant

```
Router (L2 summaries only, max 10) → Segment directors (full L1/L0 per pick) → merge
```

### Katalog segmentów (= dokumenty)

| catalogId | Źródło |
|-----------|--------|
| `l2:seg007` | L2 summary ~5–10 min |
| `scene:clip03_scene012` | highlight / cold open |
| `topic:topic_004` | cluster B-roll |
| `day:2026-07-01` | multi-clip vlog |

### SuperDirectorPlan (schema)

- `segmentOrder`, `segmentPicks[]` (max 10)
- `crossSegmentNotes[]` (callback, transition)
- `shortsSources[]`, `excludedClips[]`
- `globalTheme`, `creativityProfile`

### Luki architektoniczne

| Luka | Opis |
|------|------|
| Brak super-critic | Cross-segment continuity, payoff cold open |
| Brak drill-down per segment | Mniej L0/L1 niż legacy na długich formach |
| unpicked L2 | Pomijane z main (brak „bridge”) |
| Parallel segment directors | Sekwencyjne dziś; Promise.all możliwe |
| Token budget | Więcej wywołań LLM, ale mniejszy kontekst per call |

### Porównanie z monolitycznym directorem

| | Monolit | Super Director |
|---|---------|----------------|
| Kontekst | 25–45k tokenów, compact sceneMap | 12–22k per segment |
| Jakość długi batch | Spadek | Lepszy focus |
| Koszt | Mniej wywołań | Więcej wywołań, równoległe |
| Short content | OK | Bypass (legacy) |

---

## 10. Katalog technik i gramatyka retencji

### 26 technik, 3 packi

**Registry:** `techniques/catalog.meta.json`

| Kategoria | Techniki |
|-----------|----------|
| camera | zoom_punch_in/out, zoom_slow_push, snap_zoom, ken_burns_light, reframe_follow_subject |
| edit | cut_on_beat, cut_mid_sentence, jump_cut, match_cut, hard_cut_energy |
| transition | crossfade, dip_to_black, whip_pan, j_cut, l_cut |
| audio | music_swell, music_drop, silence_beat, voice_pitch_shift |
| graphics | hook_title_overlay, hook_visual_punch, emphasis_text, chapter_card, pattern_interrupt, retention_beat |

**Packi:**

| Pack | Zastosowanie |
|------|--------------|
| `youtube_vlog_2026` | Main 16:9 — zooms, transitions, audio; **bez** graphics retention |
| `shorts_retention_2026` | Shorts — hooki, beaty, graphics |
| `shorts_energy` | Gęsty 9:16 bez graphics pack |

### Rotacje domyślne (`shorts-retention.js`)

- **Shorts:** pattern_interrupt → retention_beat → snap_zoom → jump_cut (~25s ±5s)
- **Vlog:** zoom_slow_push → ken_burns_light → music_swell → silence_beat (~45s ±8s)

### Profile retencji

| Pole | Shorts default | Vlog default |
|------|----------------|--------------|
| `hookWindowSec` | 3 | — |
| `retentionBeatIntervalSec` | 25 | 45 |
| `requireHookMoment` | true | false |
| Auto-enable | 9:16 only / shorts level / context | 16:9 main exists |

### Luki katalog ↔ prompt

| W katalogu | Słabo w `director.md` |
|------------|----------------------|
| `dip_to_black` | Brak playbook act breaks |
| `match_cut` | Brak limitów renderera |
| `emphasis_text` | Brak |
| `music_drop` vs `music_swell` | Minimalnie |
| `shorts_energy` vs `shorts_retention_2026` | Tylko w kodzie |
| `whip_pan` | Jedna linia |
| `reframe_follow_subject` | Brak use case na beat |

### Open loops (`chapter-hints.js`)

- Max 2 hinty: `cold_open`, `payoff_tease`
- Brak structured graph (setup → payoff → l2SegmentId)
- `narrativeRole` w segment-catalog — nie w AbstractionBundle L2 schema

---

## 11. Luka: reżyser vs renderer

### Passy renderu (`execute-render.js`)

1. Segments → 2. Concat → 3. Creative → 4. Subtitles → 5. Graphics → 6. Audio mix → 7. Color grade

### Tabela wierności technik

| Technika | Director obiecuje | Renderer robi |
|----------|-------------------|---------------|
| `jump_cut`, `hard_cut_energy` | Energetyczne cięcie | **Błysk jasności ~0.12s** |
| `match_cut` | Dopasowanie wizualne | Blur + scale |
| `whip_pan` | Pan kamery | gblur kierunkowy |
| `crossfade` | Dissolve | xfade tylko przy eligible joins |
| `j_cut`, `l_cut` | Przejście A/V | `from_prev`/`from_next` — best-effort |
| `cut_on_beat` | Cięcie na beat | Snap na join concat |
| `reframe_follow_subject` | Tracking | Statyczny zoompan |
| `silence_beat` | Dramatyczna cisza | Dip głosu — **nie skraca** timeline |
| `music_swell`/`drop` | Akcent muzyczny | Wymaga music bed file |
| `hook_*`, `chapter_card` | Overlay | drawtext statyczny |
| `fitMode pillarbox` | Pasy boczne | Czarne pad (nie blur) |

### Obietnice directora nie w pełni renderowane

1. Jump cut jako skrócenie — trzeba `cuts[]` / granice segmentów.
2. Match cut / whip pan — kosmetyka.
3. Crossfade na złożonych timeline — partial.
4. J/L frame-accurate — nie.
5. `crop` w videoTransform ignorowany na pillarbox path.
6. `duckingDb` globalny — nie per-segment.
7. `segmentRole: transition|bridge` — deferred (tylko creativeMoments).
8. Animowane overlaye — brak.
9. LUT `warm_golden_hour` — stub jeśli brak pliku.

### Najwyższa wartość NOWYCH możliwości render

1. Blur pillarbox
2. Per-segment ducking (`duckingDb` per okno)
3. Prawdziwe przejścia (wipe/slide)
4. Split screen / PiP
5. Frame-accurate J/L + B-roll sync
6. Animowane overlaye
7. Time-varying reframe (tracking)
8. Prawdziwe jump cuty na join

---

## 12. Luka: retencja vs narracja

### Retencja jest „twarda”

- V22 / V22-VLOG **errors** na brak beatów
- Fixer **dodaje** beaty by naprawić błędy
- Enrichery **uzupełniają** beaty, silence_beat, SFX, chapter cards
- Critic sugeruje action na dead air bez cut/silence_beat

### Narracja jest „miękka”

- L3 `narrativeArc` — jedna linia tekstu
- Brak validatorów: payoff delivered, callback missing, beat spam
- `retentionRole: payoff` — sugestia w prompcie, nie error
- Dramatic pause vs dead air — **brak taksonomii**

### Super Director a narracja

- Długi form: **więcej retencji, mniej drill-down** — odwrotność potrzeb story-heavy filmów
- `crossSegmentNotes` — free text, nie machine-checkable

### Dead air semantyka

| Źródło | Zachowanie dziś |
|--------|-----------------|
| `deadAirHints` source both | enrich → `silence_beat` (dip) |
| Director prompt | `cuts.wordIds` |
| Brak | deterministic trim z timeline |

**Problem:** Wszystka cisza traktowana jako problem montażowy.

### Co system robi dobrze dla balansu

1. Beat anchors → `energyPeaks` + L1 `keyMoments` (nie losowe)
2. Vlog: unika agresywnych technik na beatach (V22-VLOG-03 warning)
3. V24-05 pacing vs `estimatedKeepRatio`
4. B-roll pod temat — variety bez reorder chaos
5. Cold open + rewind (enrich)
6. `creativityBudget` — cap zoomów/min

---

## 13. Enrichery deterministyczne

**Post-director** (`applyDeterministicRecipeEnrichers` w `agents.js`):

| Enricher | Co uzupełnia | Output |
|----------|--------------|--------|
| `enrichRecipeRetentionBeats` | Brakujące beaty vlog | `enrich_beat_*` |
| `enrichRecipeSilenceBeatFromDeadAir` | silence_beat przy dead air | do 3, min 45s gap |
| `enrichRecipeSfxPlan` | SFX z audioEvents | `sfxPlan[]` |
| `enrichRecipeChapterCards` | chapter_card overlays | z L2 hints |
| `enrichRecipeColdOpenSegment` | Tease + rewind | segment prepend |
| `enrichBrollSyncFromHints` | videoInSec B-roll | z keyframes/L1 |

**Render EDL** (`enrich-render-edl.js`):

- Project hook/pattern_interrupt → textOverlays
- attachSpatialRef, clamp hook window (shorts)

### Asymetria krytyczna

**Wszystkie enrichery retencji targetują `outputKind: main` — short nie ma `enrichRecipeRetentionBeats`.**

---

## 14. Walidatory V21–V25 (retencja-relevant)

| Warstwa | Kody | Egzekucja |
|---------|------|-----------|
| V21 | creative-moments.js | catalog, budget, music_swell+bed, silence_beat+silence |
| V22 | shorts-retention.js | hook, beats, overlay budget |
| V22-VLOG | vlog-retention.js | main beats, aggressive tech warnings |
| V23 | recipe-v2.js | LUFS, music track |
| V24 | recipe-v2.js | SFX density 1/90s, **V24-05 pacing** |
| V25 | broll, chronology, aspect, VO | B-roll sync, cold open rewind V25-CHR-03 |

### Brak walidacji dziś

- Chapter cards gdy `chapterCardHints` exist
- `retentionRole: payoff` przy kulminacji L2/L3
- Dead air faktycznie usunięty z timeline
- Pattern interrupt cap na main
- NAR-* narrative codes

---

## 15. Shorts vs main vlog — asymetria

| Capability | Main vlog | Short 9:16 |
|------------|-----------|------------|
| Hook 0–3s | Opcjonalny (cold open) | **Wymagany** V22 |
| Beat cadence | ~45s subtle | ~25s aggressive |
| Deterministic enrich beats | ✅ | ❌ |
| Chapter cards | textOverlays + enrich | technique short-only |
| Dead air | cut + silence_beat enrich | cuts w prompcie |
| Pacing guard V24-05 | ✅ | ❌ |
| Graphics pack | youtube_vlog (no hook gfx) | shorts_retention_2026 |

**Wniosek:** Największa luka jakości shortów = brak enrich + surowe V22.

---

## 16. Kontrolki artystyczne — braki

| Kontrola | Status | Priorytet |
|----------|--------|-----------|
| Rytm fast/slow per część filmu | ❌ | P1 narrativeProfile |
| Celowa cisza (dramatic pause) | ❌ | P1 silence taxonomy |
| Callback editing | Tekst only | P1 openLoops[] |
| Emotional beats / payoff role | Soft | P2 validator |
| Breathing room po intensity | ❌ | P1 cooldown po energyPeaks |
| Selektywne SFX (nie spam) | V24-06 warning only | P1 hard cap |
| Chapter pacing narracyjny | Mechaniczny 180–300s | P2 |
| Teaser vs payoff validation | Cold open enrich only | P2 NAR-PAYOFF |
| Audience address moments | ❌ | P3 |
| Pattern interrupt limits main | Warning only | P1 |
| CTA / end card | Wzmianka cta role | P3 |
| End screen YouTube | Poza scope | — |
| Split screen / reaction | ❌ schema | P3 |
| Blur pillarbox | ❌ render | P2 |

---

## 17. Model „sztuki filmu do internetu”

```
HOOK / obietnica (3s short | cold open main)
    → NAPIĘCIE (beat, zoom, B-roll tematyczny)
    → ODDECH (cisza zachowana, slow segment)
    → ROZWÓJ (chronologia, A-roll + B-roll)
    → PAYOFF (music_drop, retentionRole: payoff)
    → ZAMKNIĘCIE (krótko, bez dokładania beatów)
```

**Dziś dobrze:** napięcie, B-roll, muzyka, cold open.  
**Słabo:** oddech, payoff enforcement, short enrich, dead air jako dip nie cut.

---

## 18. Porównania A vs B

### Shorts beat compliance

| | A: Shorts enrich ✅ | B: Critic loop only |
|---|---------------------|---------------------|
| Niezawodność | Wysoka | Zależy od LLM |
| Narracja | Anchors z energyPeaks/L1 | Fixer może losować |
| **Verdict** | **A** | |

### Dead air

| | A: Cut w timeline ✅ | B: silence_beat dip (dziś) |
|---|----------------------|----------------------------|
| Watchability | Usuwa czas | Kosmetyka |
| Narracja | Tylko source both | Bezpieczniejsze |
| **Verdict** | **A** primary; B fallback | |

### Vlog chapter transitions

| | A: dip_to_black | B: chapter_card overlay ✅ |
|---|-----------------|------------------------------|
| Feel | Kinowy reset | YouTube-native |
| **Verdict** | Dodać do promptu | Default |

### Music emphasis

| | A: music_drop | B: music_swell |
|---|---------------|----------------|
| Use | Payoff, revelation | Beat reset, energy |
| **Verdict** | Oba w prompcie; drop na payoff | |

### TwelveLabs

| | A: Hybrid supplement ✅ | B: Replace Qwen |
|---|-------------------------|-----------------|
| **Verdict** | **A** | Florence/keyframes nadal potrzebne |

### Super Director

| | A: Router + segment directors ✅ | B: Monolit |
|---|-----------------------------------|------------|
| Długi batch | Lepszy | Gorszy |
| Krótki | Legacy bypass | OK |
| **Verdict** | **A** dla >600s lub L2>1 | |

### Narrative guardrails

| | A: Enricher caps | B: Critic narrative | C: narrativeProfile ✅ |
|---|------------------|---------------------|-------------------------|
| **Verdict** | **C + A** start; B jako NAR-* pass | |

---

## 19. Trzy podejścia do guardrails narracji

### A) Enricher rules (deterministic caps)

- **Plusy:** szybkie, testowalne, bez LLM
- **Minusy:** nie rozumie semantyki historii
- **Zastosowanie:** max pattern_interrupt/10min, cap enrich beatów, SFX limits, silencePolicy gates

### B) Critic narrative mode (LLM)

- **Plusy:** arc, payoff, callback holistycznie
- **Minusy:** koszt, konflikt z V22 errors
- **Zastosowanie:** kody NAR-PAYOFF-UNDELIVERED, NAR-BEAT-SPAM, NAR-DRAMATIC-PAUSE-CUT
- **Wymóg:** priority narrative veto > retention minimum w fixerze

### C) narrativeProfile per L2 (super-director sets)

```json
{
  "narrativeProfile": {
    "mode": "internet_documentary",
    "segments": [
      {
        "l2SegmentId": "seg002",
        "rhythm": "slow",
        "retentionIntensity": "low",
        "silencePolicy": "preserve"
      }
    ],
    "maxPatternInterruptsPer10Min": 1
  }
}
```

- **Plusy:** intent upstream, jak vlogRetentionProfile
- **Minusy:** schema + prompt + validator; bezużyteczne bez A/B enforcement

**Rekomendacja:** C jako rdzeń + A (caps) + B (NAR pass).

---

## 20. Ranking rekomendacji (P0–P3)

### P0 — wysoki wpływ, umiarkowany wysiłek

| # | Rekomendacja | Pliki |
|---|--------------|-------|
| 1 | **Shorts enrich** (hook + beats jak vlog) | `shorts-retention.js`, `agents.js` |
| 2 | **Dead air → timeline cuts** (nie tylko silence_beat) | `dead-air-enrich.js`, fixer prompt |
| 3 | **Prompt uczciwość technik** (jump_cut=pulse, dip_to_black, music_drop vs swell) | `director.md`, `critic.md` |

### P1 — sztuka + długi form

| # | Rekomendacja |
|---|--------------|
| 4 | `narrativeProfile` per L2 (rhythm, retentionIntensity, silencePolicy) |
| 5 | Taksonomia ciszy (dead_air vs dramatic_pause) |
| 6 | L3 `openLoops[]` structured + critic NAR-* |
| 7 | Shorts hook enrich z L3 best moment |
| 8 | Chapter card validator gdy hints exist |
| 9 | Fixture voiceover-mixed-day + E2E |
| 10 | Cap enrich beatów (max 2 jeśli director dał zero) |

### P2 — render / jakość wizualna

| # | Rekomendacja |
|---|--------------|
| 11 | Blur pillarbox |
| 12 | Per-segment ducking |
| 13 | Lepsze przejścia / B-roll frame sync |
| 14 | Payoff validator |
| 15 | Pacing enrich przy V24-05 (auto-trim) |
| 16 | Cold open audio bridge (W4.19-1) |

### P3 — duży koszt / opcjonalne

| # | Rekomendacja |
|---|--------------|
| 17 | Prawdziwe jump cuty w concat |
| 18 | Split screen / PiP |
| 19 | Time-varying reframe tracking |
| 20 | Animowane overlaye |
| 21 | TwelveLabs live API |
| 22 | Super-critic cross-segment |
| 23 | E2E render speed segment |
| 24 | `chapter_card.json` requiresOutputKind fix dla main |

---

## 21. Plan fazowy implementacji

### Faza 1 — szybki ROI (1–2 tyg.)

- [ ] Shorts enrich (`enrichRecipeRetentionBeats` dla `outputKind: short`)
- [ ] Dead air → cuts przy `source: "both"` high confidence
- [ ] Prompt: uczciwość technik + dip_to_black + music_drop playbook
- [ ] Cap enrich beatów na main (max 2 backfill)
- [ ] Global cap pattern_interrupt na main (validator error)

### Faza 2 — sztuka + długi form (2–4 tyg.)

- [ ] `narrativeProfile` schema + super-director output
- [ ] `silencePolicy` gates w enricherach i critic
- [ ] L3 `openLoops[]` w summarizer + AbstractionBundle schema
- [ ] Critic NAR-* codes + fixer priority rules
- [ ] Fixture `voiceover-mixed-day` + E2E mixed render
- [ ] Cooldown po `energyPeaks` (no enrich beats 30s after)

### Faza 3 — wizualna „pro” (4–8 tyg.)

- [ ] Blur pillarbox (`fitMode: blur_background` lub extend pillarbox)
- [ ] Per-segment `duckingDb` w `audioMixPlan.segments[]`
- [ ] Transition presets (wipe/slide) + SFX sync na joins
- [ ] Frame-accurate J/L i B-roll (optical flow lub scene locks)
- [ ] TwelveLabs Pegasus spike na mini-day B-roll

### Faza 4 — architektura (opcjonalnie)

- [ ] Super-critic cross-segment
- [ ] Parallel segment directors + artifact cache per segment
- [ ] Prawdziwe jump cuty (architektura concat)
- [ ] Split screen compositing mode
- [ ] Animated overlays (fade/position keyframes)

---

## 22. Czego NIE robić (antywzorce)

1. **Więcej beatów na main** bez `narrativeProfile` — już za gęsto.
2. **Traktować `jump_cut` jako prawdziwe cięcie** w komunikacji — myli directora i użytkownika.
3. **Jedna gramatyka retencji** dla short i vlog.
4. **Automatyczne SFX na każdy audio event** bez cap — V24-06 to tylko warning.
5. **Super-director bez drill-down** na story-heavy długich formach bez narrativeProfile.
6. **Replace Qwen TwelveLabs** — tracisz bbox, offline, keyframe coupling.
7. **Jeden monolityczny director** na 3h materiału — już rozwiązane Super Director (legacy bypass dla krótkich).

---

## 23. Dokumentacja — co zaktualizowano / co zostało

### Zaktualizowano w sesji 2026-07-03

- `README.md` — 14 kroków, TwelveLabs, Super Director, speed/volume, pillarbox VO, partial VO
- `docs/PRE_RENDER_PIPELINE.md` — twelvelabs, super director routing, flagi CLI
- `docs/RENDER_MODULE_SPEC.md` — speed-transform
- `docs/FORMATY_AI_I_GOTOWOSC_MONTAZU.md` — routing, speed, bez --fast
- `docs/LIVE_BATCH_CHECKLIST.md` — TwelveLabs, Super Director
- `prompts/v2/director.md` — speed, pillarbox, VO-03
- `prompts/v2/super-director.md` — próg >600s

### Nadal niezsynchronizowane / częściowo

- `docs/EDITING_RECIPE_V2_SPEC.md` — duży plik; brak pełnego fitMode, super director appendix, §14 speed
- `docs/REQUIREMENTS_SFX_LIBRARY_AND_VOICEOVER.md` — VO-G8, brak VO-03 fixture
- `docs/AUDIO_ANALYSIS_PLAN.md` — „13 kroków” → 14
- `docs/RETENTION_ENGAGEMENT_AUDIT_2026-06-28.md` — audyt sprzed shorts enrich (historyczny)
- `docs/W4_20_MULTI_CLIP_ENRICH_CLOSEOUT.md` — `fitMode: letterbox` (terminologia: pillarbox)

---

## 24. Commity i weryfikacja

### Workflow subagentów (sesja implementacyjna)

```
Analiza (3) → Implementacja (3) → Bugbot → Fix (4 rundy) → Bugbot clean
```

### Bugi naprawione (łącznie 11+)

| # | Obszar | Problem |
|---|--------|---------|
| 1 | merge | partials po indeksie zamiast segmentId |
| 2 | twelvelabs | live crash pipeline |
| 3 | speed | video_only duration mismatch |
| 4 | artifact-deps | topic_index staleness |
| 5 | merge | word cuts ignored |
| 6 | merge | wrong format fallback outputs[0] |
| 7 | merge | sfxPlan dropped |
| 8 | merge | textOverlays not retimed |
| 9 | super-director | excludedClips not enforced |
| 10 | merge | SFX offsets main-only |
| 11 | merge | segmentOrder drops picks, union outputs |
| 12 | ffmpeg-reframe | reframe center forced fill |

### Push

```bash
git push -u origin main  # wymaga poświadczeń GitHub lokalnie
```

---

## 25. Otwarte pytania

1. **TwelveLabs go/no-go** — akceptacja kosztu ~$0.5–1.5/batch?
2. **unpicked L2 segments** — pomijać czy „bridge” pass 5% keep?
3. **Speed cap mowy** — 1.5× main, 2× shorts w prompcie — hard validator?
4. **Super Director** — czy drill-down per segment na story-heavy?
5. **narrativeProfile** — kto ustawia: super-director vs user context JSON?
6. **Blur pillarbox** — FFmpeg gblur duplicate vs asset template?
7. **Fix `chapter_card` requiresOutputKind: short** — dla main używać tylko textOverlays (workaround OK)?

---

## 26. Mapa plików

| Obszar | Ścieżki |
|--------|---------|
| Director | `src/agents/director.js`, `prompts/v2/director.md` |
| Super Director | `src/agents/super-director.js`, `segment-director.js`, `src/lib/segment-catalog.js`, `src/lib/recipe-merge.js` |
| Retencja | `src/editorial/shorts-retention.js`, `chapter-hints.js`, `dead-air-enrich.js` |
| Walidatory | `src/validators/shorts-retention.js`, `vlog-retention.js`, `creative-moments.js`, `aspect-ratio.js` |
| Render | `src/render/technique-to-ffmpeg.js`, `ffmpeg-reframe.js`, `ffmpeg-creative.js`, `audio-mix.js` |
| Enrich orchestration | `src/pipeline/steps/agents.js`, `src/render/enrich-render-edl.js` |
| Techniki | `techniques/catalog.meta.json`, `techniques/packs/` |
| VO | `docs/REQUIREMENTS_SFX_LIBRARY_AND_VOICEOVER.md`, `fixtures/batches/voiceover-day/` |
| Speed | `src/render/speed-transform.js`, `src/lib/build-output-timeline.js` |
| TwelveLabs | `src/pipeline/steps/twelvelabs.js`, `src/lib/twelvelabs-merge.js` |
| Audyty | `docs/RETENTION_ENGAGEMENT_AUDIT_2026-06-28.md`, `docs/LUKI_PLAN_NAPRAWCZY.md`, `docs/W4_19_PLAN.md` |
| Ten plan | `docs/DIRECTOR_ENGAGEMENT_AND_NARRATIVE_PLAN.md` |

---

## Podsumowanie jednym akapitem

Pipeline **umie** montaż internetowy strukturalnie (timeline, VO częściowe, B-roll tematyczny, muzyka, cold open, short grammar, speed, pillarbox, super-director na długich batchach), ale **przesadza w mechanicznej retencji** (enrichery + V22 bez narracyjnych hamulców), **niedoszacowuje shorty** (brak enrich), i **myląco opisuje techniki** względem renderera (jump_cut ≠ cięcie). Najwyższy ROI bez zabijania historii: **shorts enrich + dead air cuts + narrativeProfile + enricher caps + uczciwy prompt**; wizualnie: **blur pillarbox + per-segment ducking**.

---

*Koniec planu.*
