# Wymagania: biblioteka SFX + montaż z voice-over

> **Ostatnia aktualizacja:** 2026-06-28  
> **Status ogólny:** częściowo zaimplementowane — śledzenie iteracji poniżej  
> **Powiązane:** [`assets/sfx/README.md`](../assets/sfx/README.md), [`assets/music/catalog.json`](../assets/music/catalog.json), [`src/editorial/sfx-plan.js`](../src/editorial/sfx-plan.js), [`docs/EDITING_RECIPE_V2_SPEC.md`](./EDITING_RECIPE_V2_SPEC.md)

Ten dokument służy jako **kontrakt produktowy** do wielu iteracji. Przy każdej pracy nad SFX lub voice-over: zaktualizuj checkboxy i sekcję „Stan na …”.

---

## Spis treści

1. [REQ-SFX — biblioteka dźwięków efektów](#req-sfx--biblioteka-dźwięków-efektów)
2. [REQ-VO — montaż z osobnym voice-over](#req-vo--montaż-z-osobnym-voice-over)
3. [Źródła dźwięków (licencje komercyjne)](#źródła-dźwięków-licencje-komercyjne)
4. [Macierz gotowości (skrót)](#macierz-gotowości-skrót)

---

## REQ-SFX — biblioteka dźwięków efektów

### Problem i cel

Reżyser AI powinien móc **świadomie** dodać krótkie efekty dźwiękowe (klaskanie, huk, grzmot, whoosh, śmiech itd.) do montażu — analogicznie do `musicBed`, ale dla SFX. Użycie **nie jest obowiązkowe**; Director decyduje na podstawie kontekstu (audio analysis, techniki, pacing).

**Done wygląda tak:**

- Katalog `assets/sfx/` z plikami + `catalog.json` (wzorzec jak `assets/music/`)
- Director zna `sfxId` / `label` z katalogu i może wpisać `sfxPlan[]` w EditRecipe v2.4
- Renderer (`audio-mix.js`) odtwarza wpisy `source: "library"` w osi outputu
- Łatwe dodawanie nowego dźwięku: plik + wpis w `catalog.json` + opcjonalny tag w `audio-event-tags.js`
- Propozycje z analizy audio (`buildSfxPlanFromAudio`) mapują tagi editorialne na wpisy katalogu

### Scenariusze użycia

| ID | Scenariusz | Director | Renderer |
|----|------------|----------|----------|
| SFX-01 | Podkreślenie momentu (whoosh przy przejściu) | `sfxPlan[]` z `source: "library"`, `label` / `sfxId` | Mix w `applyAudioMix` |
| SFX-02 | Reakcja widza (śmiech, aplauz) | Ręcznie lub z `sfxPlanDefaults` po detekcji PANNs | `library` lub wycinek `audio_event` |
| SFX-03 | Foley / ambience (grzmot, impact) | Technika + `sfxPlan` kotwiczony na `outputStartSec` | Overlay na voice bed |
| SFX-04 | Auto-propozycja z batcha | Brief `sfxPlanDefaults` z `buildSfxPlanFromAudio` | Director kopiuje wybrane do receptury |

### Kontrakt danych (docelowy)

```json
{
  "version": "1.0",
  "sounds": [
    {
      "sfxId": "impact_heavy_01",
      "fileName": "impact_heavy_01.wav",
      "title": "Heavy impact",
      "tags": ["impact", "foley", "hit"],
      "category": "foley",
      "durationSec": 0.8,
      "license": "CC0",
      "sourceAttribution": "optional — np. Freesound użytkownik X"
    }
  ]
}
```

**EditRecipe `sfxPlan[]` (istniejący v2.4):**

| Pole | `source: "library"` | `source: "audio_event"` |
|------|---------------------|-------------------------|
| `sfxId` | ID z katalogu lub ścieżka logiczna | `evt_<clip>_<ms>` |
| `label` | tag / nazwa pliku (np. `whoosh`, `applause`) | tag editorialny |
| `outputStartSec` / `outputEndSec` | zakres na osi outputu | zakres na osi outputu |
| `clipId` + `anchorTimeSec` | opcjonalne | **wymagane** |
| `volumeDb` | domyślnie -6 | domyślnie -6 |

### Kategorie dźwięków (początkowy zestaw)

| Tag / sfxId | Opis | Priorytet | Plik w repo |
|-------------|------|-----------|-------------|
| `whoosh` | Przejście / swipe | P0 | ✅ `whoosh.wav` (test stub) |
| `impact` | Uderzenie, huk | P0 | ✅ `impact_heavy_01.wav` (test stub) |
| `applause` | Klaskanie | P1 | ✅ `applause_short_01.wav` (test stub) |
| `thunder` | Grzmot / piorun | P1 | ✅ `thunder_rumble_01.wav` (test stub) |
| `laughter` | Śmiech | P1 | ⬜ |
| `door` | Drzwi, pukanie | P2 | ⬜ |
| `alert` | Powiadomienie, beep | P2 | ⬜ |
| `crowd` | Tłum / cheer | P2 | ⬜ |
| `squeak` | Skrzypnięcie | P3 | ⬜ |

### Implementacja — checklist

#### Infrastruktura repo

- [x] Folder `assets/sfx/` + README
- [x] `resolveSfxPath(label)` w `src/render/audio-mix.js` (szuka `.mp3`/`.wav`/`.m4a` po nazwie)
- [x] `assets/sfx/catalog.json` (jak `music/catalog.json`) — 4 wpisy, wszystkie 4 pliki WAV na dysku (stuby lavfi)
- [x] `src/editorial/sfx-library.js` — `loadSfxCatalog()`, `resolveSfxById()`, `listSfxByTag()`
- [x] `resolveSfxPath` / mix — lookup przez katalog (`sfxId` → `fileName`)
- [x] `LICENSES.md` w `assets/sfx/` — 4 wpisy `repo-generated-test-stub` (zamienić po pobraniu CC0)

#### Pre-render / Director

- [x] Schema v2.4 `sfxPlan[]` + walidacja V24-01…04
- [x] `buildSfxPlanFromAudio()` — propozycje z `audioEvents` / `editorialTags`
- [x] Director brief: `sfxPlanDefaults` w `director.js`
- [x] Prompt `prompts/v2/director.md` — sekcja „katalog SFX” z listą `sfxId` z `catalog.json`
- [x] `buildSfxPlanFromAudio` — mapowanie tag → `sfxId` z katalogu (`resolveSfxByTag`, fallback `library/sfx/<tag>`)
- [ ] Auto-wpinanie `sfxPlanDefaults` do draftu (opcjonalne, poza scope MVP)

#### Renderer

- [x] `sfxPlan` `source: "library"` — overlay w `buildAudioMixFilterGraph`
- [x] `sfxPlan` `source: "audio_event"` — wycinek z `context.clips[clipId]` + `anchorTimeSec` (`atrim`/`adelay` w `audio-mix.js`)
- [x] E2E: whoosh z `assets/sfx/` (`render-shorts.test.js`)
- [x] E2E: `audio_event` overlay (`render-shorts.test.js`)
- [x] E2E: golden recipe z natywnym `sfxPlan[]` (`golden-recipe-v2.json` v2.4, whoosh @ t=0)
- [x] Manifest: `sfxApplied: true` per output; nierozwiązane → `warnings` (`SFX_UNRESOLVED`)

#### Testy

- [x] `tests/editorial/sfx-plan.test.js`
- [x] `src/render/audio-mix.test.js` — whoosh path
- [x] `tests/editorial/sfx-library.test.js` — catalog load, resolve whoosh, missing-file null
- [ ] Contract: `catalog.json` vs schema (jak music)

### Stan na 2026-06-27 (po W4.9)

| Warstwa | % | Uwagi |
|---------|---|-------|
| Schema + walidacja | 95% | v2.4 kompletne |
| Propozycje z audio | 85% | `buildSfxPlanFromAudio` + `resolveSfxByTag` |
| Assets | 70% | 4 stuby lavfi; zamienić na CC0 produkcyjne |
| Renderer library + audio_event | 95% | `sfxApplied` w manifeście |
| Director UX | 85% | katalog SFX + workflow VO w `director.md`; critic VO |

---

## REQ-VO — montaż z osobnym voice-over

### Problem i cel

Typowy workflow vloga:

1. **Nagranie materiału wizualnego** — wiele ujęć / kadrów (B-roll, handheld, sceny bez mówienia do kamery).
2. **Późniejszy voice-over** — osobna ścieżka narracji:
   - **VO jako wideo** (np. nagranie twarzy + głos w jednym pliku, lub „talking head” do syncu)
   - **VO jako audio-only** (WAV/MP3/M4A nagrany w studiu lub na telefonie)

Reżyser powinien **planować timeline**, gdzie wideo pochodzi z jednych klipów, a **narracja z innego** — z transkryptem, cięciami słów, napisami i B-roll pod temat mowy.

### Scenariusze

| ID | Wejście | Oczekiwany montaż | Przykład segmentu |
|----|---------|-------------------|-------------------|
| VO-01 | B-roll wizualny + VO wideo (ma obraz+głos) | `videoRef` → broll, `audioRef` → klip VO, `audioPolicy: from_audio_ref` | Restauracja na ekranie, głos z osobnego nagrania „to miejsce jest…” |
| VO-02 | B-roll wizualny + VO audio-only | Jak VO-01; klip audio w `clipRegistry`, transkrypt z Whisper | Sam plik `03_voiceover.wav` |
| VO-03 | Mieszanka A-roll on-camera + późniejszy VO na części | Segmenty naprzemiennie: `from_video_ref` vs `from_audio_ref` | Wstęp do kamery, reszta pod VO |
| VO-04 | VO jako „bed” narracji + muzyka | VO = voice w `audioMixPlan`; muzyka `audioPolicy: external` | Vlog z podkładem muzycznym pod narracją |
| VO-05 | Napisy z VO | `subtitles.sourceClipId` = `audioRef.clipId` VO | Word-by-word z transkryptu narracji, nie z B-roll |

### Co już działa (bez nowego kodu)

| Możliwość | Dowód | Limit |
|-----------|-------|-------|
| Cross-clip audio na B-roll | `segmentRole: broll`, `from_audio_ref`, golden `seg_h2` | Wymaga **wideo** w `videoRef`; ingest skanuje tylko pliki wideo |
| Cięcia słów na osi audio | `cuts[]` ⊆ `audioRef.clipId` (R7) | VO musi mieć `01-words-<clipId>.json` |
| B-roll pod temat mowy | `topic-index`, `brollStrategy` | Director musi wiedzieć, że audio ≠ video |
| Osobna ścieżka muzyki | `audioMixPlan` + `audioPolicy: external` | VO to nie to samo co `external` (muzyka) |

### Luki (wymagają pracy)

| ID | Luka | Priorytet | Propozycja |
|----|------|-----------|------------|
| VO-G1 | **Ingest nie przyjmuje audio-only** | P0 | ✅ `.wav`/`.mp3`/`.m4a` w `scanInputFolder`; `mediaType: audio_only` |
| VO-G2 | **Brak roli `narration_track` / `voiceover` w clipRegistry** | P0 | ✅ enum + heurystyka `audio_only` + `hasSpeech` |
| VO-G3 | **Director prompt nie opisuje workflow VO** | P0 | ✅ sekcja VO w `prompts/v2/director.md` |
| VO-G4 | **Walidator nie wymusza spójności VO** | P1 | ✅ V25-VO-01 (`from_audio_ref` → `hasSpeech`), V25-VO-02 (napisy z transkryptu) |
| VO-G5 | **Renderer: segment tylko-audio jako źródło** | P0 | ✅ częściowo — lavfi `color=black` gdy brak `videoSourcePath`; E2E `voiceover-day` |
| VO-G6 | **Abstrakcja / summarizer** | P1 | ✅ L1 `isNarrationSource` + L3 `hasSeparateNarration` w prompcie i schemacie |
| VO-G7 | **Fixture E2E `voiceover-day`** | P1 | ✅ Batch: 2× broll MOV + 1× VO wav + golden recipe |
| VO-G8 | **VO wideo bez użycia obrazu** | P2 | `audioPolicy: from_audio_ref` już ignoruje wideo VO; opcjonalnie `videoTransform: hide` |

### Docelowy model danych (clipRegistry)

```json
{
  "clipId": "clip03",
  "fileName": "03_narration.wav",
  "durationSec": 95,
  "clipRole": "narration_track",
  "hasSpeech": true,
  "speechWordCount": 240,
  "mediaType": "audio_only"
}
```

```json
{
  "segmentId": "seg_vo_01",
  "segmentRole": "broll",
  "videoRef": { "clipId": "clip02", "sceneId": "clip02_scene001" },
  "audioRef": { "clipId": "clip03", "sceneId": "clip03_scene001" },
  "audioPolicy": "from_audio_ref",
  "syncMode": "fit_video_to_audio",
  "subtitles": { "policy": "word_by_word", "sourceClipId": "clip03" }
}
```

### Implementacja — checklist

#### Pipeline / ingest

- [x] Audio-only w inbox (`ingest.js` — rozszerzenie rozszerzeń)
- [x] `mediaType` w scene catalog / clip registry
- [ ] Transkrypcja VO (`transcribe.js` — już działa jeśli plik ma audio)
- [x] `clipRole: narration_track` w schema + clip-profile

#### Agenci

- [x] Director: workflow VO w prompcie + przykłady JSON
- [x] Critic: sprawdzanie `audioRef` narracji vs `videoRef` broll
- [x] Summarizer: wykrywanie „osobna narracja” — L1 `isNarrationSource`, L3 `hasSeparateNarration` (`prompts/v2/summarizer.md`)

#### Walidacja

- [x] R7: `cuts[].wordIds` ⊆ transkrypt `audioRef.clipId`
- [x] V25-VO-01: segment z `from_audio_ref` wymaga `audioRef` z `hasSpeech`
- [x] V25-VO-02: `subtitles.sourceClipId` musi wskazywać klip z transkryptem

#### Renderer

- [x] Osobne `-i` dla video i audio (`ffmpeg-segment.js`)
- [x] Obsługa źródła audio-only (placeholder video lub sync tylko audio w concat) — **częściowo:** lavfi black frame gdy brak `videoSourcePath`
- [x] Napisy z `sourceClipId` (`ass-subtitles.js`)

#### Testy / fixture

- [x] `fixtures/batches/voiceover-day/` — manifest, słowa, recipe, README
- [x] E2E render z VO audio-only + broll (`horizontal_main`, `short_9x16`)
- [x] E2E `segmentWarnings` — `broll_av_desync` na `seg_vo_01` (video 12s vs audio 10s)
- [x] Unit: validator VO-01, VO-02

### Stan na 2026-06-28

| Warstwa | % | Uwagi |
|---------|---|-------|
| Model receptury (cross-clip) | 85% | `from_audio_ref` wystarczy semantycznie |
| Ingest audio-only | 85% | `.wav`/`.mp3`/`.m4a` + `mediaType`; fixture `voiceover-day` |
| Director / critic / summarizer | 88% | sekcja VO w prompcie + critic; walidator V25-VO; summarizer VO hint |
| Renderer | 83% | lavfi black frame; broll+VO + manifest segmentWarnings/Errors |
| Testy E2E | 85% | voiceover-day short+main, segmentErrors mini-day, music_swell/drop |

**Werdykt:** Reżyser **może** zaplanować VO (cross-clip B-roll + narracja z osobnego klipu audio/wideo) zgodnie z promptem directora. Fixture `voiceover-day` pokrywa E2E B-roll + WAV narracji; renderer generuje czarny kadr tylko gdy brak `videoSourcePath`. Walidator V25-VO wymusza spójność `from_audio_ref` i napisów z transkryptem.

---

## Źródła dźwięków (licencje komercyjne)

Poniżej źródła nadające się do **użycia komercyjnego** (YouTube, klient, reklama). **Zawsze** zapisuj licencję per plik w `assets/sfx/LICENSES.md`.

| Źródło | Licencja | Użycie komercyjne | Uwagi |
|--------|----------|-------------------|-------|
| [Pixabay Sound Effects](https://pixabay.com/sound-effects/) | [Pixabay Content License](https://pixabay.com/service/license/) | Tak, bez atrybucji | Duży katalog; filtruj CC0; jakość mieszana |
| [Freesound](https://freesound.org) | **tylko CC0** | Tak przy CC0 | Wyszukiwarka: `license:"Creative Commons 0"`; unikaj CC-BY-NC |
| [Mixkit SFX](https://mixkit.co/free-sound-effects/) | Mixkit License | Tak, bez atrybucji | Kuratorowane pakiety |
| [OpenGameArt](https://opengameart.org) | per asset (często CC0) | Sprawdź per plik | Dobre dla impact/retro |
| [BBC Sound Effects](https://sound-effects.bbcrewind.co.uk/) | **RemArc — tylko osobiste/edukacyjne** | **Nie** do produkcji komercyjnej | Nie używać w tym projekcie komercyjnie |

**Zalecany workflow dodawania dźwięku:**

1. Pobierz z Pixabay (CC0) lub Freesound (filtr CC0).
2. Normalizuj do krótkiego WAV/MP3 (mono, 48 kHz lub 44.1 kHz).
3. Umieść w `assets/sfx/<fileName>`.
4. Dodaj wpis do `catalog.json` (`sfxId`, `tags`, `license`, `sourceAttribution`).
5. Wpis w `LICENSES.md` (URL źródła, data pobrania).
6. Uruchom `npm test -- tests/editorial/sfx-library.test.js` (gdy powstanie).

**Tagi editorialne** (`src/editorial/audio-event-tags.js`) już mapują m.in.: `applause`, `impact`, `weather` (grzmot), `laughter` — katalog SFX powinien używać **tych samych tagów** dla spójności z `buildSfxPlanFromAudio()`.

---

## Macierz gotowości (skrót)

| Wymaganie | ID | Status 2026-06-27 |
|-----------|-----|-------------------|
| Katalog SFX JSON | SFX | ✅ `catalog.json` |
| Pliki dźwiękowe (katalog) | SFX | ✅ 4 stuby WAV (`whoosh`, impact, applause, thunder) — CC0 produkcyjne TBD |
| Director zna katalog | SFX | ✅ `director.md` |
| Renderer `library` | SFX | ✅ + lookup katalog |
| Renderer `audio_event` | SFX | ✅ `audio-mix.js` + E2E |
| Cross-clip narracja (wideo VO) | VO | ✅ częściowo |
| Ingest audio-only VO | VO | ✅ podstawa (ingest + mediaType) |
| `narration_track` clip role | VO | ✅ schema + clip-profile |
| Prompt Director VO | VO | ✅ `director.md` + critic |
| Fixture + E2E voiceover | VO | ✅ `voiceover-day` (`horizontal_main`, `short_9x16`, `segmentWarnings`) |

---

## Następne iteracje (sugerowana kolejność)

1. **SFX:** zamiana stubów na CC0 produkcyjne + kontrakt `catalog.json` vs schema.
2. **VO:** E2E pixel/regresja ASS na short; summarizer `hasSeparateNarration` w pełnym live batch.
3. **Renderer:** `crossfade` przy 3+ segmentach; E2E `cut_on_beat` snap; `zoom_punch_out`; EDL realign po beat snap.

Po każdej iteracji zaktualizuj checkboxy i tabelę „Stan na …” w tym pliku.
