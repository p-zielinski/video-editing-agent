# Specyfikacja rozszerzeń: multi-clip, B-roll i rozdzielone ścieżki A/V

> Wersja dokumentu: 1.2  
> Data: 2026-06-26  
> Status: **zaimplementowane w kodzie** (pipeline 12 kroków, EditRecipe v2.0–v2.2)  
> Powiązane: [plan analizy i reżyserii](file:///Users/piotr/.cursor/plans/video_analysis_director_38a57489.plan.md), implementacja MVP w `src/`

## Spis treści

1. [Kontekst i problem](#1-kontekst-i-problem)
2. [Scenariusze użytkownika](#2-scenariusze-użytkownika)
3. [Stan obecny (MVP v1.0)](#3-stan-obecny-mvp-v10)
4. [Luki i ograniczenia AI](#4-luki-i-ograniczenia-ai)
5. [Cele v2](#5-cele-v2)
6. [Model danych v2](#6-model-danych-v2)
7. [Semantyka segmentów montażowych](#7-semantyka-segmentów-montażowych)
8. [Batch context i tryby wejścia](#8-batch-context-i-tryby-wejścia)
9. [Wykluczanie klipów i scen](#9-wykluczanie-klipów-i-scen)
10. [B-roll: dopasowanie mowy do obrazu](#10-b-roll-dopasowanie-mowy-do-obrazu)
11. [Zmiany w analizie wstępnej](#11-zmiany-w-analizie-wstępnej)
12. [Zmiany w promptach agentów](#12-zmiany-w-promptach-agentów)
13. [Walidacja i reguły scene registry w v2](#13-walidacja-i-reguły-scene-registry-w-v2)
14. [Mapowanie na przyszły etap montażu (ffmpeg)](#14-mapowanie-na-przyszły-etap-montażu-ffmpeg)
15. [Ryzyka i mitigacje](#15-ryzyka-i-mitigacje)
16. [Fazy wdrożenia](#16-fazy-wdrożenia)
17. [Kryteria akceptacji](#17-kryteria-akceptacji)
18. [Decyzje zamknięte](#18-decyzje-zamknięte-byłe-otwarte-pytania)

---

## 1. Kontekst i problem

Obecny **video-editing-agent** (MVP v1.0) realizuje pipeline „na sucho”:

```
ingest → transcribe → keyframes → vision → objects → index → clip_profile → abstract → topic_index → spatial_index → direct → review
```

(Kroki `objects` — Florence-2 wymagane; `clip_profile` / `topic_index` / `spatial_index` — v2, §11.)

Wynikiem jest **EditRecipe JSON** — receptura montażowa bez renderu ffmpeg.

MVP dobrze obsługuje:

- transkrypcję słowo-po-słowie (Whisper),
- hierarchiczne streszczenia (L1/L2/L3),
- reżyserię narracyjną (co zostawić, co wyciąć, pacing),
- minimum 1× poziomy + 1× pionowy output,
- regułę nienaruszalnego reuse scen w obrębie formatu.

**Nie opisuje wystarczająco precyzyjnie** rzeczywiste workflow vlogera:

1. Czasem wrzucam **jedno** długie wideo, czasem **kilka** klipów z jednego dnia.
2. Reżyser może **pominąć całe pliki**, jeśli są zbędne.
3. Montaż często wymaga **mieszania audio i wideo z różnych źródeł** — np. mówię do kamery (audio z clip A), a na ekranie lecą piękne ujęcia z clip B (B-roll).
4. AI musi ocenić, czy materiał nadaje się do historii, do B-roll, czy do odrzucenia.

Ten dokument specyfikuje rozszerzenia **EditRecipe v2**, analizy i agentów, aby pokryć te scenariusze bez psucia kompatybilności wstecznej z v1.0.

---

## 2. Scenariusze użytkownika

### 2.1. Pojedyncze wideo (single clip)

**Wejście:** jeden plik `vlog-11-11.mp4`, 45–120 min.

**Oczekiwania:**

- Reżyser agresywnie tnie wewnątrz jednego źródła (fillery, nuda, powtórki).
- Nie sztucznie dzieli na „wiele filmów” bez potrzeby.
- Output: min. 1× 16:9 + 1× 9:16 z tego samego materiału (reuse scen między formatami dozwolony).
- `excluded[]` dotyczy **scen/fragmentów**, nie całych plików (bo jest tylko jeden plik).

**Przykładowy kontekst CLI:**

```bash
--context "jeden długi vlog z 11 listopada, dzień 66/100 challenge, cel: 12–18 min YouTube + 3 shorty"
```

### 2.2. Wiele klipów — jeden dzień / jedna opowieść (multi-clip day)

**Wejście:** folder z 5–20 plików (rano, popołudnie, wieczór, B-roll drone, outtakes).

**Oczekiwania:**

- Reżyser układa **jedną spójną narrację** z wielu źródeł.
- Może **odrzucić całe klipy** (`excluded` z `clipId`, `reason`, `confidence`).
- Kolejność montażu ≠ koniecznie kolejność nagrania (chronologia logiczna > chronologia plików).
- Klipy **bez mowy** nie są automatycznie śmieciami — mogą być wyłącznie B-roll.

**Przykładowy kontekst CLI:**

```bash
--context "vlog 11 listopada; clip01-03 gadanie do kamery; clip04-06 same ujęcia B-roll; clip07 outtakes — raczej wykluczyć"
```

### 2.3. B-roll pod narrację (cross-clip A/V)

**Wejście:** clip A = talking head z pełnym audio; clip B/C = ujęcia miejsc, jedzenia, krajobrazu (często bez mowy lub z szumem tła).

**Oczekiwania montażowe:**

- **Audio** ciągle z clip A (fragment mowy 45.0–51.0 s).
- **Wideo** z clip B (np. 12.0–18.0 s — zachód słońca).
- Napisy zsynchronizowane z **audio** (słowa z clip A), nie z wideo B.
- Segment oznaczony jako `segmentRole: "broll"`.

**To NIE jest to samo co J-cut/L-cut** w obrębie jednego klipu (`audioPolicy: from_prev`), choć oba mogą współistnieć w jednym timeline.

### 2.4. Mieszane: dzień z jednym głównym + B-roll + śmieci

Typowy realny batch:

| Plik | Zawartość | Rola oczekiwana |
|------|-----------|-----------------|
| `01_intro.MOV` | gadanie, słabe światło | może wykluczyć lub 1 scena |
| `02_walk.MOV` | spacer + komentarz | A-roll |
| `03_food_broll.MOV` | tylko jedzenie, brak mowy | B-roll pool |
| `04_drone.MOV` | drone, muzyka w tle | B-roll pool |
| `05_outtakes.MOV` | powtórki, zająknięcia | wykluczyć lub minimalnie |

Reżyser powinien zwrócić:

- `excluded[]` dla `05_outtakes` (cały clip),
- `clipRole` w `clipRegistry` dla `03`, `04` jako `broll_pool`,
- timeline z segmentami `aroll` + `broll` z rozdzielonymi `audioRef` / `videoRef`.

### 2.5. Jeden klip, ale z wbudowanym B-roll w tym samym pliku

Nagranie zawiera zarówno twarz do kamery, jak i przebitki w **tym samym pliku** (bez osobnego pliku B-roll).

**Oczekiwania:**

- `videoRef` i `audioRef` wskazują ten sam `clipId`, różne `sceneId` lub zakresy czasowe.
- `segmentRole: "broll"` nadal sensowne (zmiana obrazu przy tej samej ścieżce audio w obrębie jednego pliku).

**Reguła normatywna — intra-clip cutaway (ten sam ref, różne zakresy czasowe):**

Gdy `audioRef` i `videoRef` wskazują **ten sam** `clipId` + `sceneId`, ale `audioInSec`/`audioOutSec` ≠ `videoInSec`/`videoOutSec` → segment jest **intra-clip B-roll** (cutaway w obrębie jednej sceny):

- `segmentRole: "broll"`
- `audioPolicy: "from_audio_ref"` (wymagane — audio i wideo mają różne zakresy w źródle)
- Jawne `audioInSec`/`audioOutSec` (zakres mowy) oraz `videoInSec`/`videoOutSec` (zakres obrazu cutaway)

```json
{
  "segmentRole": "broll",
  "videoRef": { "clipId": "clip01", "sceneId": "clip01_scene005" },
  "audioRef": { "clipId": "clip01", "sceneId": "clip01_scene005" },
  "videoInSec": 12.0,
  "videoOutSec": 18.0,
  "audioInSec": 45.0,
  "audioOutSec": 51.0,
  "audioPolicy": "from_audio_ref",
  "intent": "Cutaway jedzenia w tej samej scenie — mowa ciągnie pod przebitkę"
}
```

---

## 3. Stan obecny (MVP v1.0)

### 3.1. Co działa

| Obszar | Implementacja |
|--------|----------------|
| Wiele plików w folderze | `ingest.js` → `clip01`, `clip02`, … |
| Sceny per clip | `SceneCatalog`, scene detection |
| Wykluczenia | `excluded[]` z opcjonalnym `clipId` / `sceneId` |
| Audio policy | `source`, `from_prev`, `from_next`, `external`, `mute` |
| Reżyseria dwuetapowa | L3+L2 → drill-down L1+L0 |
| Scene registry | brak reuse scen w tym samym formacie między outputami |

### 3.2. Model segmentu v1.0 (uproszczony)

```json
{
  "segmentId": "seg_001",
  "sourceRef": { "clipId": "clip01", "sceneId": "clip01_scene003" },
  "videoInSec": 10.0,
  "videoOutSec": 25.0,
  "audioPolicy": "source",
  "audioOffsetSec": 0
}
```

**Założenie ukryte:** audio i wideo pochodzą z **tego samego** `sourceRef` (plus ewentualny J/L-cut od sąsiada w timeline).

### 3.3. Prompt directora v1 (skrót)

Obecny `prompts/v1/director.md` mówi o:

- min. 16:9 + 9:16,
- odważnych cięciach,
- J-cut/L-cut (`from_prev`, `from_next`),
- fillerach.

**Nie mówi** o:

- trybie single vs multi clip,
- pomijaniu całych plików,
- klipach bez mowy jako B-roll pool,
- cross-clip B-roll,
- różnicy między „wyklucz z historii” a „zostaw tylko do przebitek”.

### 3.4. Brief directora v1

`buildDirectorBrief()` dostarcza:

- `sessionSummary` (L3), `segmentSummaries` (L2),
- `sceneMap` (sceneId, clipId, czasy, hasSpeech),
- `fillerStats` per scena.

**Brakuje:**

- `clipSummaries` (rola całego pliku),
- `brollCandidates` (sceny/klipy wizualnie mocne, bez mowy),
- `topicIndex` (tematy mowy mapowane na sceny),
- jawnego `inputMode`.

---

## 4. Luki i ograniczenia AI

### 4.1. Co AI oceni dobrze

| Zadanie | Dlaczego |
|---------|----------|
| Skrócenie 3h → 15 min (nuda, powtórki) | Whisper + L2/L3 + reżyser z `qualityOverQuantity` |
| Wykrycie fillerów i zająknięć | word-level + heurystyki `srt-processor` |
| Wybór „ciekawych” fragmentów mówionych | L1 per scena + kontekst użytkownika |
| Min. 2 formaty wyjściowe | walidator + prompt |
| Odrzucenie słabego klipu (outtakes) | L3 + excluded z reason |

### 4.2. Gdzie AI będzie słabsze

| Zadanie | Ryzyko | Mitigacja w v2 |
|---------|--------|----------------|
| Dopasowanie B-roll do **konkretnego zdania** | ~6 klatek/min — łatwo przegapić ujęcie | gęstszy sampling w scenach bez mowy oznaczonych jako `broll_pool`; topic tags |
| „Czy to ładne ujęcie” vs „shakecam śmieć” | Qwen na pojedynczych klatkach | `visualQuality` + `stability` w L1; **Florence-2** (wymagany krok pipeline) |
| Sync audio 45s clip A + wideo 12s clip B | brak `audioRef`/`videoRef` w v1 | **schemat v2** |
| Klip bez mowy odrzucony przez pomyłkę | prompt sugeruje „tnij wszystko” | `clipRole: broll_pool`, reguła w krytyku |
| Halucynacja Whisper vs wizja | rzadkie, ale możliwe | critic z `timelineCrossCheck` (już jest) — rozszerzyć o B-roll |

### 4.3. Realistyczne oczekiwania (normatywne)

**EditRecipe v2 to plan intencji**, nie gwarancja kinowej synchronizacji. Dla cross-clip B-roll:

- AI powinno wskazać **które ujęcie** i **przy której mowie** (±1–3 s),
- precyzyjny montaż (frame-accurate) może wymagać ludzkiej korekty lub etapu montażu z automatycznym dopasowaniem.

Te ograniczenia są **kryteriami akceptacji** (patrz §17.6), nie disclaimerem.

---

## 5. Cele v2

1. **Jednoznaczny model** cross-clip audio + wideo (B-roll).
2. **Jawne role klipów** (A-roll, B-roll pool, wykluczony, nieokreślony).
3. **Prompty i brief** opisujące single vs multi clip bez zgadywania przez model.
4. **Analiza** wzbogacona o tagi wizualne i tematyczne pod B-roll.
5. **Walidacja** rozumiejąca, że `audioRef.clipId ≠ videoRef.clipId` jest legalne.
6. **Kompatybilność wsteczna:** v1 segmenty mapują się na v2 (`audioRef = videoRef = sourceRef`).

---

## 6. Model danych v2

### 6.0. Reguły kanoniczne (normatywne)

Poniższe reguły są **obowiązkowe** dla wszystkich artefaktów v2, przykładów w prompcie i walidatora Zod.

| # | Reguła |
|---|--------|
| R1 | **`MediaRef` = `{ clipId, sceneId }` wyłącznie** — bez pól czasowych w ref. |
| R2 | **Wszystkie czasy na segmencie:** `videoInSec`, `videoOutSec`, `audioInSec`, `audioOutSec` (number, sekundy w źródle). |
| R3 | **Segmenty v2 NIE zawierają `sourceRef`** — pole istnieje tylko w wejściu migracji v1→v2. |
| R4 | Gdy `audioRef` równa się `videoRef` (ten sam `clipId` + `sceneId`) **oraz** `audioInSec`/`audioOutSec` = `videoInSec`/`videoOutSec` → `audioPolicy: "from_video_ref"`. |
| R4b | Gdy `audioRef` === `videoRef` (ten sam `clipId` + `sceneId`) **oraz** `audioInSec`/`audioOutSec` ≠ `videoInSec`/`videoOutSec` → `segmentRole: "broll"`, `audioPolicy: "from_audio_ref"` (intra-clip cutaway, §2.5). |
| R5 | Gdy `segmentRole: "broll"` **i** (`audioRef` ≠ `videoRef` **lub** zakresy audio ≠ wideo) → `audioPolicy: "from_audio_ref"` **wymagane**. |
| R6 | **`audioOffsetSec` jest DEPRECATED w v2** — nie używać w nowych segmentach; migrator ustawia `audioInSec`/`audioOutSec` z offsetu v1. |
| R7 | **`cuts[].wordIds`** muszą należeć wyłącznie do transkryptu `audioRef.clipId` (nie `videoRef.clipId`). |
| R8 | **`outputStartSec` / `outputEndSec`** na segmencie opisują pozycję w timeline outputu (patrz §14.1); jeśli brak — renderer wywołuje `buildOutputTimeline()`. |

**Przykład poprawnego segmentu (cross-clip B-roll):**

```json
{
  "segmentId": "seg_012",
  "segmentRole": "broll",
  "videoRef": { "clipId": "clip04", "sceneId": "clip04_scene001" },
  "audioRef": { "clipId": "clip01", "sceneId": "clip01_scene008" },
  "videoInSec": 12.0,
  "videoOutSec": 18.0,
  "audioInSec": 45.0,
  "audioOutSec": 51.0,
  "audioPolicy": "from_audio_ref",
  "syncMode": "align_start"
}
```

### 6.1. Wersjonowanie

```json
{
  "version": "2.0",
  "batchId": "abc12345",
  "batchContext": { ... },
  "clipRegistry": [ ... ],
  "outputs": [ ... ],
  "excluded": [ ... ],
  "sceneUsageRegistry": [ ... ]
}
```

v1.0 pozostaje obsługiwane; migrator `v1 → v2` ustawia `audioRef = videoRef = sourceRef`.

### 6.2. `clipRegistry` (nowe)

Rejestr metadanych per plik źródłowy — uzupełniany w kroku `clip_profile` (§11), przed reżyserią.

```json
{
  "clipId": "clip03",
  "fileName": "03_food_broll.MOV",
  "durationSec": 124.5,
  "sortIndex": 2,
  "clipRole": "broll_pool",
  "roleConfidence": 0.88,
  "roleSource": "clip_profile",
  "hasSpeech": false,
  "speechWordCount": 0,
  "visualSummary": "Ujęcia jedzenia, restauracja, zbliżenia talerzy.",
  "topics": ["jedzenie", "restauracja"],
  "visualQuality": "high",
  "excludeFromMainStory": false,
  "excludeReason": null
}
```

**`clipRole` enum:**

| Wartość | Znaczenie |
|---------|-----------|
| `aroll_primary` | główne gadanie / narracja |
| `aroll_secondary` | wspierające A-roll (mniej ważne) |
| `broll_pool` | tylko lub głównie do przebitek |
| `outtakes` | kandydat do pełnego wykluczenia |
| `undecided` | reżyser ma zdecydować (domyślne po ingest) |

**`roleSource` enum:** `clip_profile` | `context_override` | `director`

**Precedencja roli klipu:** `--context` / `batchContext` (użytkownik) **>** `clip_profile` (reguły + opcjonalny LLM) **>** `director` (propozycja w EditRecipe).

#### Tabela pól Zod — `ClipRegistryEntry`

| Pole | Typ Zod | Wymagane | Opis |
|------|---------|----------|------|
| `clipId` | `z.string()` | tak | Id z ingest |
| `fileName` | `z.string()` | tak | Oryginalna nazwa pliku |
| `durationSec` | `z.number().positive()` | tak | Długość klipu |
| `sortIndex` | `z.number().int().nonnegative()` | tak | Kolejność w batchu |
| `clipRole` | `z.enum([...])` | tak | Patrz enum powyżej |
| `roleConfidence` | `z.number().min(0).max(1)` | nie | Pewność przypisania roli |
| `roleSource` | `z.enum([...])` | nie | Skąd pochodzi rola |
| `hasSpeech` | `z.boolean()` | tak | Czy Whisper znalazł mowę |
| `speechWordCount` | `z.number().int().nonnegative()` | tak | Liczba słów |
| `visualSummary` | `z.string()` | nie | Opis wizualny (LLM lub reguły) |
| `topics` | `z.array(z.string())` | nie | Tagi tematyczne |
| `visualQuality` | `z.enum(["low","medium","high"])` | nie | Jakość wizualna |
| `excludeFromMainStory` | `z.boolean()` | nie | Hint dla directora |
| `excludeReason` | `z.string().nullable()` | nie | Uzasadnienie wykluczenia |

### 6.3. `MediaRef` (zamiast pojedynczego `sourceRef`)

```json
{
  "clipId": "clip01",
  "sceneId": "clip01_scene005"
}
```

**Normatywnie (R1):** `MediaRef` zawiera **wyłącznie** `clipId` i `sceneId`. Czasy **nigdy** nie wchodzą do ref — zawsze na segmencie jako `videoInSec`/`videoOutSec`/`audioInSec`/`audioOutSec`.

#### Tabela pól Zod — `MediaRef`

| Pole | Typ Zod | Wymagane | Opis |
|------|---------|----------|------|
| `clipId` | `z.string()` | tak | Id klipu źródłowego |
| `sceneId` | `z.string()` | tak | Id sceny w SceneCatalog |

### 6.4. `TimelineSegment` v2

```json
{
  "segmentId": "seg_012",
  "segmentRole": "broll",
  "videoRef": {
    "clipId": "clip03",
    "sceneId": "clip03_scene002"
  },
  "audioRef": {
    "clipId": "clip01",
    "sceneId": "clip01_scene008"
  },
  "videoInSec": 12.0,
  "videoOutSec": 18.0,
  "audioInSec": 45.0,
  "audioOutSec": 51.0,
  "audioPolicy": "from_audio_ref",
  "syncMode": "align_start",
  "outputStartSec": 120.0,
  "outputEndSec": 126.0,
  "cuts": [],
  "subtitles": {
    "policy": "word_by_word",
    "sourceClipId": "clip01",
    "style": "default"
  },
  "textOverlays": [],
  "videoTransform": { "reframe": "center", "speed": 1 },
  "intent": "Podczas mowy o restauracji — ujęcia jedzenia z clip03"
}
```

**Pola segmentu v2:**

| Pole | Typ | Opis |
|------|-----|------|
| `segmentRole` | `aroll` \| `broll` | intencja montażowa (`transition`, `bridge` — **deferred v2.1**, patrz §7.1) |
| `videoRef` | MediaRef | skąd bierzemy obraz (R1: bez czasów) |
| `audioRef` | MediaRef | skąd bierzemy dźwięk (R1: bez czasów) |
| `videoInSec` / `videoOutSec` | number | zakres wideo w źródle |
| `audioInSec` / `audioOutSec` | number | zakres audio w źródle (może ≠ video) |
| `outputStartSec` / `outputEndSec` | number | pozycja w timeline outputu (opcjonalne; patrz §14.1) |
| `overlapSec` | number | domyślnie `0`; sekundy nakładania audio sąsiada przy J/L-cut (§7.5, §14.1) |
| `audioPolicy` | enum | patrz §7.2 |
| `syncMode` | enum | patrz §7.6 |
| `allowBrollReuse` | boolean | gdy `true`, ta sama `videoRef.sceneId` może pojawić się ponownie w tym output (§9.3) |
| `subtitles` | object | napisy — timing względem **output timeline** (§7.7) |
| `textOverlays` | array | nakładki tekstowe — timing względem **output timeline** (§7.7) |
| `intent` | string | ludzki opis dla montażysty / review |

#### Tabela pól Zod — `TimelineSegmentV2`

| Pole | Typ Zod | Wymagane | Opis |
|------|---------|----------|------|
| `segmentId` | `z.string()` | tak | Unikalny w obrębie outputu |
| `segmentRole` | `z.enum(["aroll","broll"])` | tak | v2.1 rozszerzy o transition/bridge |
| `videoRef` | `MediaRef` | tak | Ref wideo |
| `audioRef` | `MediaRef` | tak | Ref audio |
| `videoInSec` | `z.number().nonnegative()` | tak | Start wideo w źródle |
| `videoOutSec` | `z.number().positive()` | tak | Koniec wideo (> videoInSec) |
| `audioInSec` | `z.number().nonnegative()` | tak | Start audio w źródle |
| `audioOutSec` | `z.number().positive()` | tak | Koniec audio (> audioInSec) |
| `outputStartSec` | `z.number().nonnegative()` | nie | Start w timeline outputu |
| `outputEndSec` | `z.number().positive()` | nie | Koniec w timeline outputu |
| `overlapSec` | `z.number().nonnegative()` | nie | Domyślnie `0`; overlap J/L-cut |
| `audioPolicy` | `z.enum([...])` | tak | Patrz §7.2 |
| `syncMode` | `z.enum([...])` | nie | Domyślnie `align_start` |
| `allowBrollReuse` | `z.boolean()` | nie | Domyślnie `false` |
| `cuts` | `z.array(Cut)` | nie | Cięcia w obrębie audioRef |
| `subtitles` | `SubtitlesConfig` | nie | Konfiguracja napisów |
| `textOverlays` | `z.array(TextOverlay)` | nie | Nakładki tekstowe |
| `videoTransform` | `VideoTransform` | nie | Reframe, speed |
| `intent` | `z.string()` | nie | Opis intencji |

**Kompatybilność v1 (wejście migracji):** jeśli segment ma `sourceRef` zamiast `audioRef`/`videoRef`, migrator ustawia `audioRef = videoRef = sourceRef` (bez `sourceRef` w outputcie v2).

### 6.4.1. `Cut` / `WordCut` (normatywny)

Cięcia fillerów i ciszy na poziomie słów — zgodne z v1, rozszerzone o regułę R7 (clip audioRef):

```json
{
  "startWordId": "clip01_w0042",
  "endWordId": "clip01_w0048",
  "reason": "filler",
  "keepIfStoryCritical": false
}
```

| Pole | Typ Zod | Wymagane | Opis |
|------|---------|----------|------|
| `startWordId` | `z.string()` | tak | Pierwsze słowo zakresu do wycięcia |
| `endWordId` | `z.string()` | tak | Ostatnie słowo zakresu (włącznie) |
| `reason` | `z.string()` | tak | Uzasadnienie (np. `filler`, `silence`, `repetition`) |
| `keepIfStoryCritical` | `z.boolean()` | nie | Domyślnie `false`; `true` zachowuje mimo filler tagu |

**Reguła R7 (normatywna):** `startWordId` i `endWordId` muszą należeć do transkryptu `audioRef.clipId` (nie `videoRef.clipId`). Przy `segmentRole: broll` słowa pochodzą z klipu z mową (`audioRef`), nie z klipu B-roll.

### 6.5. `OutputRecipe` v2 (rozszerzenia)

Każdy element `outputs[]` opisuje jeden render docelowy:

| Pole | Typ | Wymagane | Opis |
|------|-----|----------|------|
| `outputId` | string | tak | Unikalny identyfikator outputu |
| `format` | `"16:9"` \| `"9:16"` | tak | Format wyjściowy |
| `outputKind` | `"main"` \| `"short"` | tak | Rodzaj outputu (normatywne) |
| `title` | string | tak | Tytuł |
| `synopsis` | string | nie | Krótki opis (zachowane z v1) |
| `targetDurationSec` | number | nie | Cel długości (zachowane z v1) |
| `timeline` | `TimelineSegment[]` | tak | Segmenty montażowe |
| `chapterMarkers` | array | nie | Markery rozdziałów YouTube (zachowane z v1) |

**Reguły `outputKind` (normatywne):**

- Minimum **1× `outputKind: "main"`** per wymagany format (`requiredFormats`).
- Shorty: `outputKind: "short"`, `format: "9:16"`, max `shortsMaxDurationSec` (domyślnie 60 s) — **standalone highlights**, nie automatyczne wycinki z main.
- Ten sam `sceneId` może być reuse między `main` i `short` oraz między formatami (SR3).

```json
{
  "outputId": "youtube_16x9",
  "format": "16:9",
  "outputKind": "main",
  "title": "Dzień 66 — jedzenie i miasto",
  "targetDurationSec": 900,
  "timeline": []
}
```

### 6.6. Rozszerzone `excluded`

Model wykluczeń jest **kompletny** — trzy typy z jawnymi regułami walidacji.

#### `exclusionType: whole_clip`

Wyklucza cały plik z głównej narracji.

```json
{
  "clipId": "clip07",
  "exclusionType": "whole_clip",
  "usableAsBroll": false,
  "reason": "Same powtórki i przejęzyczenia bez wartości narracyjnej.",
  "confidence": 0.92
}
```

| Reguła | Opis |
|--------|------|
| Wymagane | `clipId` |
| Zakazane | `sceneId`, `timeRange` |
| `usableAsBroll: false` | Klip nie może pojawić się w żadnym segmencie (ani A-roll, ani B-roll) |
| `usableAsBroll: true` | **NIEDOZWOLONE** dla `whole_clip` — walidator ERROR `EXCLUSION_USABLE_BROLL_WHOLE_CLIP` |

#### `exclusionType: scene`

Wyklucza pojedynczą scenę z głównej narracji.

```json
{
  "sceneId": "clip02_scene004",
  "clipId": "clip02",
  "exclusionType": "scene",
  "usableAsBroll": true,
  "reason": "Zbyt ciemne ujęcie, ale 2s może posłużyć jako przejście.",
  "confidence": 0.7
}
```

| Reguła | Opis |
|--------|------|
| Wymagane | `sceneId` |
| Zalecane | `clipId` (dla jednoznaczności) |
| `usableAsBroll: true` | Scena może pojawić się wyłącznie w `segmentRole: "broll"` |
| `usableAsBroll: false` | Scena całkowicie zablokowana |

#### `exclusionType: time_range`

Wyklucza fragment czasowy w obrębie klipu.

```json
{
  "clipId": "clip02",
  "sceneId": "clip02_scene003",
  "exclusionType": "time_range",
  "timeRange": { "startSec": 45.0, "endSec": 52.0 },
  "usableAsBroll": false,
  "reason": "Kamera skierowana w ziemię, brak treści.",
  "confidence": 0.85
}
```

| Reguła | Opis |
|--------|------|
| Wymagane | `clipId`, `timeRange.startSec`, `timeRange.endSec` |
| Opcjonalne | `sceneId` (jeśli znany) |
| `usableAsBroll: true` | Fragment może być użyty jako B-roll; segment musi mieć `videoInSec`/`videoOutSec` poza zakresem wykluczenia lub w nim z `segmentRole: "broll"` |
| `usableAsBroll: false` | Fragment zablokowany we wszystkich segmentach |

#### Tabela pól Zod — `ExclusionEntry`

| Pole | Typ Zod | Wymagane | Opis |
|------|---------|----------|------|
| `clipId` | `z.string()` | warunkowo | Wymagane dla `whole_clip`, `time_range` |
| `sceneId` | `z.string()` | warunkowo | Wymagane dla `scene` |
| `exclusionType` | `z.enum(["whole_clip","scene","time_range"])` | tak | Typ wykluczenia |
| `timeRange` | `{ startSec, endSec }` | warunkowo | Wymagane dla `time_range` |
| `usableAsBroll` | `z.boolean()` | tak | Czy dozwolony jako B-roll |
| `reason` | `z.string()` | tak | Uzasadnienie |
| `confidence` | `z.number().min(0).max(1)` | nie | Pewność decyzji |

### 6.7. Rozszerzony `batchContext`

```json
{
  "inputMode": "single_clip",
  "theme": "vlog 11 listopada",
  "challengeDay": "66/100",
  "targetPlatforms": ["youtube", "shorts"],
  "qualityOverQuantity": true,
  "allowWholeClipExclusion": true,
  "brollStrategy": "match_speech_topics",
  "brollMatchThreshold": 0.55,
  "allowBrollReuse": false,
  "maxBrollSegmentsPerOutput": 30,
  "requiredFormats": ["16:9", "9:16"],
  "shortsStrategy": "standalone_highlights",
  "shortsMaxDurationSec": 60,
  "notes": "clip04-06 tylko B-roll"
}
```

**`inputMode`:** `single_clip` | `multi_clip_day` | `multi_clip_collection` (przyszłość)

**`requiredFormats`** (kanoniczne): lista wymaganych formatów wyjściowych, np. `["16:9", "9:16"]`. Minimum 2 formaty w MVP.

> **Alias:** `minOutputs` jest **deprecated** — jeśli oba pola obecne, `requiredFormats` wygrywa; walidator emituje WARNING `DEPRECATED_MIN_OUTPUTS`.

**`brollStrategy`:**

| Wartość | Zachowanie reżysera |
|---------|---------------------|
| `match_speech_topics` | szukaj zgodności tematycznej mowa ↔ obraz |
| `chronological` | B-roll w kolejności nagrania |
| `director_choice` | model decyduje swobodnie |
| `minimal` | unikaj B-roll, tylko A-roll |

#### Tabela pól Zod — `BatchContextV2`

| Pole | Typ Zod | Wymagane | Domyślna | Opis |
|------|---------|----------|----------|------|
| `inputMode` | `z.enum([...])` | nie | heurystyka | §8.1 |
| `theme` | `z.string()` | nie | — | Temat vloga |
| `challengeDay` | `z.string()` | nie | — | Np. "66/100" |
| `targetPlatforms` | `z.array(z.string())` | nie | — | youtube, shorts |
| `qualityOverQuantity` | `z.boolean()` | nie | `true` | Agresywność cięć |
| `allowWholeClipExclusion` | `z.boolean()` | nie | `true` | Multi-clip |
| `brollStrategy` | `z.enum([...])` | nie | `match_speech_topics` | Strategia B-roll |
| `brollMatchThreshold` | `z.number().min(0).max(1)` | nie | `0.55` | Próg topicIndex |
| `allowBrollReuse` | `z.boolean()` | nie | `false` | SR2 override |
| `maxBrollSegmentsPerOutput` | `z.number().int().positive()` | nie | `30` | Cap B-roll |
| `requiredFormats` | `z.array(z.string()).min(2)` | tak | — | Wymagane formaty |
| `minOutputs` | `z.array(z.string())` | nie | — | **Deprecated** alias |
| `shortsStrategy` | `z.enum(["standalone_highlights"])` | nie | `standalone_highlights` | Strategia shortów |
| `shortsMaxDurationSec` | `z.number().positive()` | nie | `60` | Max długość shorta |
| `notes` | `z.string()` | nie | — | Notatki użytkownika |

---

## 7. Semantyka segmentów montażowych

### 7.1. `segmentRole`

| Rola | Audio typowo | Wideo typowo | Status v2 |
|------|--------------|--------------|-----------|
| `aroll` | z tego samego klipu co wideo (lub J/L-cut od sąsiada) | talking head / główna akcja | **MVP** |
| `broll` | z innego (lub tego samego) klipu — **mowa** | ujęcia ilustracyjne | **MVP** |
| `transition` | z poprzedniego lub muzyka | krótkie przejście wizualne | **deferred v2.1** |
| `bridge` | łączenie narracji między klipami | może być mix | **deferred v2.1** |

Walidator v2 akceptuje wyłącznie `aroll` i `broll`. Wartości `transition`/`bridge` są zarezerwowane — director ich nie emituje w v2.

**Przypadek drone (§2.4, `04_drone.MOV`):** klip z muzyką/szumem tła, bez mowy narracyjnej → `clipRole: broll_pool`. Segment B-roll:

```json
{
  "segmentRole": "broll",
  "videoRef": { "clipId": "clip04", "sceneId": "clip04_scene001" },
  "audioRef": { "clipId": "clip01", "sceneId": "clip01_scene005" },
  "videoInSec": 0, "videoOutSec": 8,
  "audioInSec": 120, "audioOutSec": 128,
  "audioPolicy": "from_audio_ref",
  "syncMode": "align_start",
  "intent": "Drone landscape pod narracją — wycisz natywne audio drona"
}
```

Natywne audio drona jest **ignorowane** — `audioPolicy: from_audio_ref` bierze mowę z A-roll, nie audio z `videoRef`.

### 7.2. `audioPolicy` (v2)

| Wartość | Znaczenie | Kiedy używać |
|---------|-----------|--------------|
| `from_audio_ref` | użyj `audioRef` + `audioInSec`/`audioOutSec` | **Wymagane** gdy `segmentRole: broll` i refs różne (R5) |
| `from_video_ref` | audio z tego samego co wideo | Gdy `audioRef === videoRef` i czasy równe (R4) |
| `from_prev` | J-cut: audio z poprzedniego segmentu w **timeline outputu** | Sąsiedni segment, ten sam output |
| `from_next` | L-cut: audio z następnego segmentu | Sąsiedni segment, ten sam output |
| `external` | zewnętrzna ścieżka (muzyka) | **deferred v2.1** |
| `mute` | brak audio | Segment wizualny bez dźwięku |

v1 `source` → v2 `from_video_ref` gdy `audioRef === videoRef` i czasy równe.

**Reguły walidacji:**

- `from_audio_ref` → wymagaj `audioInSec` < `audioOutSec`
- `from_prev` / `from_next` → wymagaj sąsiedni segment w timeline; `audioRef` sąsiada jest źródłem
- `mute` → `audioInSec`/`audioOutSec` ignorowane przez renderer

### 7.3. `syncMode` — podstawy

Określa jak wyrównać długości audio i wideo gdy różne. Szczegółowa tabela decyzyjna w §7.6.

| Wartość | Zachowanie |
|---------|------------|
| `align_start` | początek audio i wideo razem (domyślne) |
| `align_end` | końcówki razem |
| `fit_video_to_audio` | przytnij / rozciągnij wideo (speed w `videoTransform`) |
| `fit_audio_to_video` | przytnij audio (rzadkie) |
| `loop_video` | zapętl wideo jeśli krótsze (np. 3s klip na 10s mowy) |

### 7.4. Różnica: J-cut vs cross-clip B-roll

```
J-cut (ten sam batch, sąsiednie segmenty w timeline):
  seg1: wideo kończy się, audio ciągnie → seg2
  audioPolicy: from_prev na seg2

Cross-clip B-roll:
  seg: wideo z clip03, audio z clip01 (różne audioInSec/audioOutSec vs videoInSec/videoOutSec)
  audioRef ≠ videoRef, segmentRole: broll, audioPolicy: from_audio_ref
```

Oba mogą wystąpić w jednym filmie.

### 7.5. J-cut / L-cut z `audioRef` (normatywne)

J-cut i L-cut operują na **timeline outputu**, nie na źródłowych clipach. Przy v2:

**J-cut (`from_prev` na segmencie N):**

- Wideo seg N zaczyna się w `outputStartSec(N)`
- Audio seg N-1 **ciągnie** do `outputStartSec(N) + overlapSec`
- `audioRef` seg N-1 pozostaje źródłem audio; seg N ma `audioPolicy: "from_prev"`
- `audioInSec`/`audioOutSec` na seg N **nie są używane** — audio pochodzi z sąsiada

```json
{
  "segmentId": "seg_003",
  "segmentRole": "aroll",
  "videoRef": { "clipId": "clip01", "sceneId": "clip01_scene004" },
  "audioRef": { "clipId": "clip01", "sceneId": "clip01_scene003" },
  "videoInSec": 60, "videoOutSec": 90,
  "audioPolicy": "from_prev",
  "intent": "J-cut: audio z poprzedniej sceny ciągnie pod nowe wideo"
}
```

**L-cut (`from_next` na segmencie N):**

- Wideo seg N kończy się, ale audio seg N+1 zaczyna się przed końcem wideo seg N
- Seg N: `audioPolicy: "from_next"`; audio z `audioRef` seg N+1

**Zasady łączenia z B-roll (normatywne):**

- J/L-cut **nie zastępują** cross-clip B-roll — to osobne mechanizmy.
- **ZABRONIONE:** ten sam segment **nie może** jednocześnie mieć `audioPolicy: "from_audio_ref"` **oraz** `from_prev`/`from_next`. To sprzeczne źródła audio na jednym segmencie.
- **DOZWOLONE:** segment `broll` z `audioPolicy: "from_prev"` — audio ciągnie z poprzedniego segmentu A-roll pod wideo B-roll (J-cut pod przebitką). W tym przypadku `audioInSec`/`audioOutSec` na segmencie `broll` **nie są używane**; źródłem jest audio poprzednika w timeline outputu.
- **DOZWOLONE:** segment `broll` z `audioPolicy: "from_audio_ref"` — klasyczny cross-clip lub intra-clip cutaway (§2.5).
- Pole `overlapSec` (domyślnie `0`) określa, o ile sekund audio poprzednika wystaje pod wideo następnika (patrz §14.1).

```json
{
  "segmentId": "seg_004",
  "segmentRole": "broll",
  "videoRef": { "clipId": "clip03", "sceneId": "clip03_scene002" },
  "audioRef": { "clipId": "clip01", "sceneId": "clip01_scene008" },
  "videoInSec": 5, "videoOutSec": 11,
  "audioPolicy": "from_prev",
  "overlapSec": 1.5,
  "intent": "J-cut: mowa z poprzedniego A-roll ciągnie pod ujęcia jedzenia"
}
```

### 7.6. Tabela decyzyjna `syncMode`

| Warunek | `syncMode` | Uwagi |
|---------|------------|-------|
| `segmentRole: aroll`, refs równe, długości równe | `align_start` (domyślny) | Typowy A-roll |
| `segmentRole: broll`, `videoDur < audioDur`, wideo ≥ 3s | `align_start` | Wideo kończy się wcześniej — OK jeśli następny segment przejmuje |
| `segmentRole: broll`, `videoDur < audioDur`, wideo < 3s | `loop_video` | Krótkie ujęcie B-roll |
| `segmentRole: broll`, `videoDur > audioDur` | `fit_video_to_audio` | Przytnij wideo do długości mowy |
| `segmentRole: broll`, `videoDur ≈ audioDur` (±0.5s) | `align_start` | Idealne dopasowanie |
| J-cut / L-cut (`from_prev`/`from_next`) | `align_start` | SyncMode ignorowany dla audio sąsiada |
| `audioPolicy: mute` | dowolny | Renderer nie synchronizuje audio |
| `fit_audio_to_video` | tylko gdy audio znacząco dłuższe i nie ma sensu loop | Rzadkie; critic WARNING |

Gdzie `videoDur = videoOutSec - videoInSec`, `audioDur = audioOutSec - audioInSec`.

### 7.7. Timing napisów i `textOverlays` (normatywne)

**Wszystkie czasy w `subtitles` i `textOverlays` są względem timeline OUTPUTU**, nie źródłowego klipu.

| Pole | Odniesienie czasowe | Opis |
|------|---------------------|------|
| `subtitles.sourceClipId` | źródło słów | Zawsze klip z mową (`audioRef.clipId` przy B-roll) |
| `subtitles.outputStartSec` | output timeline | Kiedy napisy zaczynają się w renderze |
| `subtitles.outputEndSec` | output timeline | Kiedy napisy kończą się w renderze |
| `textOverlays[].outputStartSec` | output timeline | Start nakładki |
| `textOverlays[].outputEndSec` | output timeline | Koniec nakładki |
| `textOverlays[].text` | — | Treść nakładki |

**Mapowanie słów na output timeline:**

1. Dla segmentu: `word.outputTimeSec = segment.outputStartSec + (word.sourceTimeSec - segment.audioInSec)`
2. Przy `segmentRole: broll`: słowa z `audioRef.clipId`, nie `videoRef.clipId`
3. Przy J-cut (`from_prev`): napisy podążają za audio sąsiada — renderer używa `outputStartSec` sąsiada

```json
{
  "subtitles": {
    "policy": "word_by_word",
    "sourceClipId": "clip01",
    "outputStartSec": 120.0,
    "outputEndSec": 126.0,
    "style": "default"
  },
  "textOverlays": [
    {
      "text": "Dzień 66/100",
      "outputStartSec": 0.5,
      "outputEndSec": 4.0,
      "position": "top_center"
    }
  ]
}
```

#### Tabela pól Zod — `SubtitlesConfig`

| Pole | Typ Zod | Wymagane | Opis |
|------|---------|----------|------|
| `policy` | `z.enum(["word_by_word","phrase","off"])` | tak | Styl napisów |
| `sourceClipId` | `z.string()` | tak | Klip z transkryptem (= audioRef.clipId przy broll) |
| `outputStartSec` | `z.number().nonnegative()` | nie | Start w output timeline |
| `outputEndSec` | `z.number().positive()` | nie | Koniec w output timeline |
| `style` | `z.string()` | nie | Preset stylu |

#### Tabela pól Zod — `TextOverlay`

| Pole | Typ Zod | Wymagane | Opis |
|------|---------|----------|------|
| `text` | `z.string()` | tak | Treść |
| `outputStartSec` | `z.number().nonnegative()` | tak | Start w output timeline |
| `outputEndSec` | `z.number().positive()` | tak | Koniec w output timeline |
| `position` | `z.string()` | nie | Np. `top_center` |

---

## 8. Batch context i tryby wejścia

### 8.1. Automatyczne wykrywanie `inputMode`

| Warunek | `inputMode` |
|---------|-------------|
| 1 plik w folderze | `single_clip` |
| 2+ plików | `multi_clip_day` (domyślne) |

### 8.2. Precedencja `inputMode` (normatywne)

| Priorytet | Źródło | Opis |
|-----------|--------|------|
| 1 (najwyższy) | `--input-mode` CLI | Jawny flag (przyszły) |
| 2 | `batchContext.inputMode` w `--context` JSON | Użytkownik w kontekście |
| 3 | Heurystyka ingest | 1 plik → `single_clip`, 2+ → `multi_clip_day` |

Director i krytyk **muszą** respektować rozstrzygnięty `inputMode` — nie mogą go zmieniać w EditRecipe.

### 8.3. Wpływ na reżysera

**single_clip:**

- nie generuj `excluded` z `whole_clip` (chyba że użytkownik prosi),
- skup się na cięciach wewnątrz scen,
- B-roll tylko w obrębie tego pliku (zmiana sceneId przy tym samym audio).

**multi_clip_day:**

- aktywnie rozważ wykluczenie słabych klipów,
- buduj `clipRegistry` z rolami,
- agresywnie używaj `broll_pool` do ilustracji mowy z `aroll_primary`.

**Shorts (`shortsStrategy: standalone_highlights`):**

- Shorty są **osobnymi narracyjnymi highlightami** (max `shortsMaxDurationSec`, domyślnie 60s każdy)
- **Nie są** automatycznymi wycinkami z głównego 16:9 — director komponuje je niezależnie
- Reuse scen między formatami (16:9 ↔ 9:16 ↔ shorts) jest **dozwolony** (scene registry per format)
- Short może zawierać cross-clip B-roll tak jak główny output

### 8.4. Przykłady `--context` (dokumentacja dla użytkownika)

```
# Single
"jeden długi vlog, target 15 min, challenge 66/100"

# Multi z rolą klipów
"clip01-02 A-roll; clip03-05 B-roll jedzenie i miasto; clip06 wykluczyć"

# Multi bez wskazówek — AI wnioskuje
"vlog z 11 listopada, 8 plików z całego dnia"
```

---

## 9. Wykluczanie klipów i scen

### 9.1. Drzewo decyzji reżysera

```
Dla każdego clipId:
  1. Czy clip ma wartość narracyjną (mowa + treść)?
     TAK → aroll_primary / aroll_secondary
  2. Czy clip jest wyłącznie wizualny ale wysokiej jakości?
     TAK → broll_pool (NIE excluded)
  3. Czy to outtakes / duplikaty / techniczne śmieci?
     TAK → excluded (whole_clip) LUB outtakes + usableAsBroll: false
  4. Niepewne → undecided → L3 + drill-down
```

### 9.2. Reguła krytyka

Krytyk powinien flagować:

- `ERROR`: wykluczono `broll_pool` z `usableAsBroll: false` bez uzasadnienia,
- `WARNING`: `whole_clip` excluded ale `clipRole` był `aroll_primary`,
- `SUGGESTION`: długi A-roll bez B-roll przy opisie jedzenia w transkrypcie.

### 9.3. Scene registry — reguły deterministyczne (normatywne)

Scene registry śledzi użycie scen w outputach. Reguły są **deterministyczne** — bez „prawdopodobnie”.

#### Rejestracja scen

Dla każdego segmentu w `output.timeline[]`:

1. **Zawsze** rejestruj `videoRef.sceneId` (primary).
2. Jeśli `audioRef.sceneId` ≠ `videoRef.sceneId` → rejestruj **również** `audioRef.sceneId`.
3. Klucz rejestru: `(outputId, format, sceneId)`.

#### Reguły unikalności

| Reguła | Opis | Naruszenie |
|--------|------|------------|
| SR1 | Ten sam `sceneId` **nie może** pojawić się w dwóch różnych `outputId` **tego samego `format`** | ERROR `SCENE_REUSE_SAME_FORMAT` |
| SR2 | W obrębie jednego `outputId`: ten sam `videoRef.sceneId` **nie może** pojawić się 2×, chyba że `segment.allowBrollReuse: true` **lub** `batchContext.allowBrollReuse: true` | ERROR `SCENE_DUPLICATE_IN_OUTPUT` |
| SR3 | Reuse scen między **różnymi formatami** (16:9 ↔ 9:16 ↔ shorts) jest **dozwolony** | — |
| SR4 | `audioRef.sceneId` podlega SR1–SR2 tak samo jak `videoRef.sceneId` | ERROR jak wyżej |
| SR5 | Scena z `excluded` gdzie `usableAsBroll: false` → blokada we wszystkich segmentach | ERROR `SCENE_EXCLUDED` |
| SR6 | Scena z `excluded` gdzie `usableAsBroll: true` → dozwolona **wyłącznie** w `segmentRole: "broll"` | ERROR `SCENE_AROLL_EXCLUDED` |

#### B-roll reuse w tym samym output

**Decyzja (§18.1):** reuse tej samej sceny B-roll wielokrotnie w jednym output jest **dozwolony** gdy:

- `segment.allowBrollReuse: true` na segmencie ponownie używającym sceny, **lub**
- `batchContext.allowBrollReuse: true` (globalnie dla batchu)

Bez tych flag → ERROR `SCENE_DUPLICATE_IN_OUTPUT`. Critic emituje **WARNING** `BROLL_REUSE_FREQUENT` gdy ta sama scena B-roll pojawia się > 3× w jednym output.

#### Reuse między formatami (§18.7)

**Decyzja:** ta sama scena B-roll w 16:9 i 9:16 jest **dozwolona i zamierzona** — to nie jest naruszenie scene registry (SR3).

---

## 10. B-roll: dopasowanie mowy do obrazu

### 10.1. `topicIndex` (nowy artefakt analizy)

Generowany deterministycznie w kroku pipeline **`topic_index`**, **po** `abstract`, **przed** `direct` (artefakt `05b-topic-index.json`, §11.3). **Nie** w kroku `index`.

```json
{
  "topics": [
    {
      "topicId": "topic_001",
      "label": "restauracja",
      "wordIds": ["clip01_w0042", "clip01_w0043"],
      "timeRange": { "clipId": "clip01", "startSec": 44.0, "endSec": 58.0 },
      "matchingScenes": [
        { "sceneId": "clip03_scene002", "score": 0.85, "reason": "visual: jedzenie" }
      ]
    }
  ]
}
```

**Źródła score:**

- overlap słów kluczowych (transkrypt),
- tagi Qwen (`visionCaptions`) na keyframes,
- detekcje obiektów Florence-2 (`objectDetections`) — **wymagany krok pipeline**; +0.15 gdy label obiektu pasuje do `topic.label`,
- embedding similarity (przyszłość).

### 10.2. Algorytm proponowany dla reżysera (wysokopoziomowy)

1. Z L2/L3 wybierz **kluczowe momenty mowy** (nie wszystkie 3h).
2. Dla każdego momentu: `topicIndex.matchingScenes` posortowane po `score`.
3. Wybierz segment `broll` jeśli `score >= brollMatchThreshold` (domyślnie **0.55**) i scena nie użyta.
4. Ustaw `audioInSec`/`audioOutSec` na zakres mowy, `videoInSec`/`videoOutSec` na najlepszy fragment sceny B-roll.
5. Jeśli wideo krótsze → `syncMode: loop_video` lub wybierz dłuższy fragment.

### 10.3. Gęstość analizy wizualnej dla B-roll pool

Dla klipów `broll_pool` / scen bez mowy:

- zwiększ `maxFramesPerMin` (np. 12 zamiast 6),
- priorytet keyframes: każda nowa scena + środek sceny,
- opcjonalnie niższy próg `cutScore` dla motion.

### 10.4. Ograniczenia

- Bez topicIndex reżyser opiera się na L1 — działa dla prostych vlogów, słabo dla 10+ klipów.
- Score < `brollMatchThreshold` → lepiej zostawić A-roll niż wstawić losowe ujęcie.

### 10.5. Algorytm MVP `topicIndex` (normatywny)

Generowany deterministycznie w kroku pipeline **po** `abstract` (artefakt `05b-topic-index.json`, §11). Director **MUSI** korzystać z istniejących wpisów — **nie wolno** wymyślać nowych `topicId` ani `matchingScenes`.

**Wejście:** L2/L3 abstrakcje, L1 scen, `clipRegistry`, `WordIndex` per clip.

**Krok 1 — Ekstrakcja tematów mowy:**

```
Dla każdego clipId z hasSpeech=true:
  1. Zbierz unikalne lematy/tokeny z L2 segmentów (min. 2 wystąpienia lub w L3 keywords).
  2. Grupuj słowa w topicId (np. topic_001) z label (np. "restauracja").
  3. Przypisz wordIds i timeRange { clipId, startSec, endSec }.
```

**Krok 2 — Scoring scen B-roll:**

```
Dla każdego topicId:
  Dla każdej sceny z clipRole=broll_pool LUB hasSpeech=false:
    score = 0
    score += 0.4 * keywordOverlap(topic.label, scene.topics)     // 0 lub 0.4
    score += 0.3 * (scene.brollPotential ?? 0)                   // z L1 (po abstract)
    score += 0.2 * visualQualityWeight(scene.visualQuality)      // z L1; high=0.2, med=0.1, low=0
    score += 0.1 * stabilityWeight(scene.stability)              // z L1; stable=0.1, shaky=0
    score += 0.15 jeśli objectDetections (Florence-2) zawiera label pasujący do topic.label  // wymagany pipeline step
    Jeśli scene w excluded z usableAsBroll=false → score = 0
    Dodaj do matchingScenes jeśli score > 0
  Sortuj matchingScenes malejąco po score
```

**Krok 3 — Próg i filtrowanie:**

```
threshold = batchContext.brollMatchThreshold ?? 0.55
Dla każdego topicId:
  matchingScenes = matchingScenes.filter(s => s.score >= threshold)
  Ogranicz do top 5 scen per topic
```

**Krok 4 — Director consumption:**

Director wybiera segmenty `broll` **wyłącznie** z `topicIndex.topics[].matchingScenes` gdzie `score >= threshold`. Nie dodaje scen spoza indeksu. Jeśli brak match → zostaw A-roll (critic SUGGESTION `BROLL_OPPORTUNITY_MISSED`, nie ERROR).

**Język:** MVP topicIndex działa w języku transkryptu. Cross-language matching — deferred.

#### Tabela pól Zod — `TopicIndex`

| Pole | Typ Zod | Wymagane | Opis |
|------|---------|----------|------|
| `topics` | `z.array(TopicEntry)` | tak | Lista tematów |
| `topics[].topicId` | `z.string()` | tak | Stabilny identyfikator |
| `topics[].label` | `z.string()` | tak | Etykieta ludzka |
| `topics[].wordIds` | `z.array(z.string())` | tak | Słowa z transkryptu |
| `topics[].timeRange` | `{ clipId, startSec, endSec }` | tak | Zakres mowy |
| `topics[].matchingScenes` | `z.array(MatchingScene)` | tak | Posortowane po score |
| `matchingScenes[].sceneId` | `z.string()` | tak | Scena B-roll |
| `matchingScenes[].score` | `z.number().min(0).max(1)` | tak | Wynik algorytmu |
| `matchingScenes[].reason` | `z.string()` | nie | Uzasadnienie |

---

## 11. Zmiany w analizie wstępnej

### 11.1. Nowe pola L1 (scena)

```json
{
  "sceneId": "clip03_scene002",
  "summary": "...",
  "mood": "ciepły, apetyczny",
  "keyMoments": ["zbliżenie na pizzę"],
  "visualQuality": "high",
  "stability": "stable",
  "hasSpeech": false,
  "brollPotential": 0.9,
  "topics": ["jedzenie", "restauracja"]
}
```

### 11.2. Krok `clip_profile` (normatywny)

Nowy krok pipeline między `index` a `abstract`.

**Placement w pipeline:**

```
ingest → transcribe → keyframes → vision → index
  → clip_profile          # NOWY
  → abstract
  → topic_index           # NOWY (po abstract)
  → spatial_index         # NOWY (kotwice bbox z Florence)
  → direct → review
```

**Artefakty** (zgodne z `work-paths.js` — do dodania w implementacji):

| Krok | Artefakt | Zawartość |
|------|----------|-----------|
| `index` | `05-timeline-index.json` | TimelineIndex (istniejący) |
| `clip_profile` | `05a-clip-registry.json` | `clipRegistry[]` z rolami |
| `abstract` | `06-abstract-L1.json`, `06-abstract-L2.json`, `06-abstract-L3.json` | Abstrakcje |
| `topic_index` | `05b-topic-index.json` | TopicIndex (§10.5) |
| `spatial_index` | `05c-spatial-index.json` | SpatialIndex — kotwice face/subject/object per scena |
| `direct` | `07-edit-recipe-draft.json` | EditRecipe v2 |

> Numeracja `05b` po `06-abstract` jest zamierzona — artefakt powstaje po abstract, ale prefix `05` grupuje artefakty analityczne przed reżyserią.

**Algorytm `clip_profile`:**

> **Ważne:** `clip_profile` działa **przed** `abstract` — **nie używa** pól L1 (`visualQuality`, `brollPotential`, `topics` z summarizera). Źródło danych: wyłącznie `05-timeline-index.json` + `SceneCatalog`.

1. **Rule-based pre-pass** (deterministyczny, dane z `timelineIndex`):
   - `hasSpeech=false` + heurystyka wizualna z indexu (`visionCaptions` z Qwen, `objectDetections` z Florence-2, liczba keyframes / `durationSec` sceny) → `clipRole: broll_pool`, `roleConfidence: 0.7`
   - `hasSpeech=true` + dominacja scen z mową → `aroll_primary` lub `aroll_secondary` (wg `speechWordCount` vs mediana batchu)
   - `fillerRatio > 0.6` (z `WordIndex`) + niska stabilność (keyframes/scena — shakecam heuristic: mało klatek + krótka scena z dużym ruchem) → `outtakes`, `roleConfidence: 0.6`
   - `visualQuality` w `clipRegistry` — **opcjonalne** pole pochodzące z heurystyki indexu (`high` gdy ≥3 visionCaptions i Florence labels; `medium` gdy captions bez detekcji; `low` gdy brak captions), **nie** z L1
   - Inne → `undecided`, `roleConfidence: 0.3`

2. **Opcjonalny LLM pass** (gdy `OPENAI_API_KEY` dostępny, **po** rule-based):
   - Generuje `visualSummary` per clip (agregacja `visionCaptions` + `objectDetections` z indexu, nie L1)
   - Może podnieścić/obniżyć `roleConfidence` o ±0.15
   - **Nie zmienia** roli jeśli `roleSource: context_override`

3. **Zapis:** `05a-clip-registry.json` z polami `roleConfidence`, `roleSource: "clip_profile"`.

**L1 wzbogaca później:** po `abstract` pola `visualQuality`, `brollPotential`, `topics` per scena trafiają do L1 i są używane przez `topic_index` oraz directora — ale **nie** przez `clip_profile`.

**Precedencja roli:** `--context` / `batchContext` **>** `clip_profile` **>** `director` (director może proponować zmianę w `excluded`, ale nie nadpisuje `clipRegistry` bez uzasadnienia — critic WARNING `CLIP_ROLE_OVERRIDE`).

### 11.3. Krok `topic_index`

Patrz §10.5. Uruchamiany po `abstract`, przed `spatial_index`. Idempotentny — pomija jeśli `05b-topic-index.json` istnieje (chyba `--force`).

### 11.4. Krok `spatial_index`

Generowany deterministycznie **po** `topic_index`, **przed** `direct` (artefakt `05c-spatial-index.json`).

**Wejście:** `objectDetections` z `05-timeline-index.json` (Florence-2), wymaga `bbox` per detekcja.

**Wyjście:** `SpatialIndex` — per scena lista `anchors[]` z polami:

| Pole | Typ | Opis |
|------|-----|------|
| `type` | `face` \| `subject` \| `object` | Heurystyka z labeli Florence |
| `bbox` | `[x, y, w, h]` | Znormalizowane 0–1 (top-left origin) |
| `timestampSec` | number | Czas klatki źródłowej |
| `label` | string | Etykieta OD |
| `confidence` | 0–1 | Score detekcji |

**Normalizacja bbox:** piksele z Florence są dzielone przez `scene.resolution` (lub `clip.resolution`). W trybie stub (`vision_florence.py`) zwracany jest bbox znormalizowany `[0.25, 0.2, 0.5, 0.6]`.

Director mapuje `spatialIndex` → `creativeMoments[].spatialRef` dla technik wymagających kotwicy (zoom, reframe).

**`spatialRef` (creativeMoments):**

| Pole | Typ | Opis |
|------|-----|------|
| `clipId` | string | Wymagane — klip źródłowy (prefiks `sceneId`) |
| `sceneId` | string | Wymagane — scena z spatial index |
| `timestampSec` | number | Opcjonalne przy bbox — czas kotwicy w klipie |
| `anchorType` | `face` \| `subject` \| `object` | Wymagane z `bbox` |
| `bbox` | `[x, y, w, h]` | Znormalizowane 0–1 (xywh); preferowane z `primaryAnchor` |

Wymagane: `timestampSec` **lub** (`bbox` + `anchorType`). Walidator **V21-10** sprawdza `sceneId` i zgodność bbox z `05c-spatial-index.json`.

### 11.5. Artefakty v2 (pełna lista)

| Plik | Krok | Zawartość |
|------|------|-----------|
| `05-timeline-index.json` | index | Indeks timeline |
| `05a-clip-registry.json` | clip_profile | clipRole, visualSummary, topics, roleConfidence |
| `06-abstract-L1.json` | abstract | L1 per scena |
| `06-abstract-L2.json` | abstract | L2 segmenty |
| `06-abstract-L3.json` | abstract | L3 sesja |
| `05b-topic-index.json` | topic_index | topic → sceny (score) |
| `05c-spatial-index.json` | spatial_index | kotwice przestrzenne per scena |
| `07-edit-recipe-draft.json` | direct | EditRecipe v2 |
| `08-review.json` | review | ReviewResult |
| `09-edit-recipe-final.json` | review | Finalna receptura |

---

## 12. Zmiany w promptach agentów

### 12.1. Director v2 (kluczowe dodatki)

- Sekcja **Tryb wejścia** (single vs multi).
- Sekcja **Wykluczanie klipów** z `exclusionType` i `usableAsBroll`.
- Sekcja **B-roll** z przykładami JSON `audioRef`/`videoRef`.
- Jawna reguła: *klipy bez mowy ≠ śmieci*.
- Przykład cross-clip w few-shot (1 przykład w prompcie).

### 12.2. Summarizer v2

- L1: obowiązkowo `brollPotential`, `topics`, `visualQuality`.
- L3: `recommendedClipRoles` per clipId.

### 12.3. Critic v2

- Sprawdza spójność B-roll z `topicIndex` (sceny spoza indeksu → ERROR).
- Flaguje B-roll bez `audioRef` z mową.
- Weryfikuje `subtitles.sourceClipId` przy `segmentRole: broll`.
- Weryfikuje scene registry (SR1–SR6).
- Sprawdza `cuts[].wordIds` ⊆ transkrypt `audioRef.clipId`.

#### Enum kodów błędów krytyka (normatywny)

| Kod | Severity | Opis |
|-----|----------|------|
| `BROLL_AUDIO_MISMATCH` | ERROR | `segmentRole: broll` bez `audioPolicy: from_audio_ref` lub brak mowy w audioRef |
| `BROLL_SCENE_NOT_IN_TOPIC_INDEX` | ERROR | Scena B-roll nie występuje w topicIndex dla danego tematu |
| `BROLL_OPPORTUNITY_MISSED` | SUGGESTION | Mowa o temacie z topicIndex, ale brak segmentu B-roll |
| `BROLL_REUSE_FREQUENT` | WARNING | Ta sama scena B-roll > 3× w jednym output |
| `SCENE_REUSE_SAME_FORMAT` | ERROR | sceneId w dwóch outputId tego samego formatu (SR1) |
| `SCENE_DUPLICATE_IN_OUTPUT` | ERROR | Duplikat videoRef.sceneId w output bez allowBrollReuse (SR2) |
| `SCENE_EXCLUDED` | ERROR | Użycie sceny z excluded usableAsBroll=false |
| `SCENE_AROLL_EXCLUDED` | ERROR | Scena excluded usableAsBroll=true w segmentRole aroll |
| `EXCLUSION_USABLE_BROLL_WHOLE_CLIP` | ERROR | whole_clip z usableAsBroll=true |
| `CUT_WORDID_WRONG_CLIP` | ERROR | cuts[].wordId nie należy do audioRef.clipId (R7) |
| `AUDIO_POLICY_VIOLATION` | ERROR | Naruszenie R4/R5 (zły audioPolicy dla refs) |
| `SYNC_MODE_MISMATCH` | WARNING | syncMode niezgodny z tabelą §7.6 |
| `SUBTITLE_SOURCE_MISMATCH` | ERROR | subtitles.sourceClipId ≠ audioRef.clipId przy broll |
| `SUBTITLE_TIMING_INVALID` | ERROR | outputStartSec/outputEndSec poza segmentem output |
| `CLIP_ROLE_OVERRIDE` | WARNING | Director zmienił clipRole vs clipRegistry bez uzasadnienia |
| `DEPRECATED_MIN_OUTPUTS` | WARNING | Użyto minOutputs zamiast requiredFormats |
| `MISSING_REQUIRED_FORMAT` | ERROR | Brak wymaganego formatu z requiredFormats |
| `TOPIC_INDEX_HALLUCINATION` | ERROR | Director użył topicId/sceny spoza topicIndex |
| `INVALID_MEDIA_REF_TIMES` | ERROR | MediaRef zawiera pola czasowe (naruszenie R1) |
| `INVALID_TIME_RANGE` | ERROR | `videoInSec` ≥ `videoOutSec` lub `audioInSec` ≥ `audioOutSec` (V3) |
| `INVALID_EXCLUSION` | ERROR | Brak wymaganych pól dla `exclusionType` (V9, V10) |
| `INVALID_SEGMENT_ROLE` | ERROR | `segmentRole` poza {`aroll`, `broll`} (V19) |
| `DEPRECATED_AUDIO_OFFSET` | WARNING | Segment v2 zawiera `audioOffsetSec` (V18) |
| `SOURCE_REF_IN_V2_SEGMENT` | ERROR | Segment v2 zawiera sourceRef (naruszenie R3) |
| `WHOLE_CLIP_EXCLUDED_IN_SINGLE` | WARNING | whole_clip excluded przy inputMode single_clip |
| `MAX_BROLL_EXCEEDED` | WARNING | Liczba segmentów broll > maxBrollSegmentsPerOutput |

### 12.4. Fixer v2

- Potrafi naprawić `audioRef`/`videoRef` gdy critic zgłosi `BROLL_AUDIO_MISMATCH`.

---

## 13. Walidacja i reguły scene registry w v2

### 13.1. Reguły walidacji Zod (normatywne, 20 reguł)

| # | Reguła | Kod błędu |
|---|--------|-----------|
| V1 | `MediaRef` zawiera wyłącznie `clipId` + `sceneId` (R1) | `INVALID_MEDIA_REF_TIMES` |
| V2 | Segment v2 nie zawiera `sourceRef` (R3) | `SOURCE_REF_IN_V2_SEGMENT` |
| V3 | `videoInSec` < `videoOutSec`, `audioInSec` < `audioOutSec` | `INVALID_TIME_RANGE` |
| V4 | Gdy `audioRef === videoRef` i czasy równe → `audioPolicy: from_video_ref` (R4) | `AUDIO_POLICY_VIOLATION` |
| V5 | Gdy `segmentRole: broll` i (refs różne **lub** zakresy audio ≠ wideo) → `audioPolicy: from_audio_ref` (R5, R4b) | `AUDIO_POLICY_VIOLATION` |
| V6 | `segmentRole: broll` z różnymi refs → wymagaj `audioInSec`/`audioOutSec` | `BROLL_AUDIO_MISMATCH` |
| V7 | `cuts[].wordIds` ⊆ WordIndex[audioRef.clipId] (R7) | `CUT_WORDID_WRONG_CLIP` |
| V8 | `exclusionType: whole_clip` → wymagany `clipId`, zakazany `usableAsBroll: true` | `EXCLUSION_USABLE_BROLL_WHOLE_CLIP` |
| V9 | `exclusionType: scene` → wymagany `sceneId` | `INVALID_EXCLUSION` |
| V10 | `exclusionType: time_range` → wymagany `clipId` + `timeRange` | `INVALID_EXCLUSION` |
| V11 | `subtitles.sourceClipId` = `audioRef.clipId` przy `segmentRole: broll` | `SUBTITLE_SOURCE_MISMATCH` |
| V12 | `subtitles.outputStartSec`/`outputEndSec` w obrębie segment output timeline | `SUBTITLE_TIMING_INVALID` |
| V13 | `syncMode: loop_video` → `videoDur` < `audioDur` | `SYNC_MODE_MISMATCH` |
| V14 | Scene registry SR1–SR6 (§9.3) | `SCENE_*` kody |
| V15 | `requiredFormats` — min. 2 formaty, każdy obecny w outputs | `MISSING_REQUIRED_FORMAT` |
| V16 | `minOutputs` traktowane jako alias `requiredFormats` (deprecated) | `DEPRECATED_MIN_OUTPUTS` |
| V17 | Segment `broll` videoRef.sceneId musi być w topicIndex lub clipRole=broll_pool | `BROLL_SCENE_NOT_IN_TOPIC_INDEX` |
| V18 | `audioOffsetSec` obecny w segmencie v2 → WARNING deprecated | `DEPRECATED_AUDIO_OFFSET` |
| V19 | `segmentRole` ∈ {`aroll`, `broll`} tylko | `INVALID_SEGMENT_ROLE` |
| V20 | Liczba segmentów broll ≤ `maxBrollSegmentsPerOutput` (domyślnie 30) | `MAX_BROLL_EXCEEDED` |

### 13.2. Scene registry

Implementacja w `src/validators/scene-registry.js` — reguły SR1–SR6 z §9.3. Rejestracja `videoRef.sceneId` (primary) + `audioRef.sceneId` gdy różne.

### 13.3. Migracja v1 → v2

```javascript
function migrateSegmentV1ToV2(seg) {
  const ref = { clipId: seg.sourceRef.clipId, sceneId: seg.sourceRef.sceneId };
  const audioIn = seg.videoInSec + (seg.audioOffsetSec ?? 0);
  const audioOut = seg.videoOutSec + (seg.audioOffsetSec ?? 0);
  const { sourceRef, audioOffsetSec, ...rest } = seg;
  return {
    ...rest,
    segmentRole: "aroll",
    videoRef: ref,
    audioRef: ref,
    videoInSec: seg.videoInSec,
    videoOutSec: seg.videoOutSec,
    audioInSec: audioIn,
    audioOutSec: audioOut,
    audioPolicy: seg.audioPolicy === "source" ? "from_video_ref" : seg.audioPolicy,
    overlapSec: 0,
    textOverlays: (seg.textOverlays ?? []).map((o) => ({
      ...o,
      outputStartSec: o.outputStartSec ?? o.startSec,
      outputEndSec: o.outputEndSec ?? o.endSec,
      startSec: undefined,
      endSec: undefined,
    })),
  };
}
```

**Mapowanie pól v1 → v2 (migrator bez zmian semantyki):**

| Pole v1 | Pole v2 | Uwagi |
|---------|---------|-------|
| `textOverlays[].startSec` | `textOverlays[].outputStartSec` | v1 timing względem segmentu → v2 względem output timeline |
| `textOverlays[].endSec` | `textOverlays[].outputEndSec` | j.w. |
| `source` (audioPolicy) | `from_video_ref` | gdy refs i czasy równe |
| `audioOffsetSec` | `audioInSec`/`audioOutSec` | offset dodany do zakresu wideo |

### 13.4. Pola v1 zachowane w v2 (migrator)

Następujące pola **pozostają** w EditRecipe v2 — migrator v1→v2 **nie usuwa** ich i **nie zmienia** semantyki:

| Pole | Poziom | Opis |
|------|--------|------|
| `needsHumanReview` | root | Flaga po pętli critic/fixer |
| `reviewNotes` | root | Notatki z review |
| `chapterMarkers` | `outputs[]` | Markery YouTube |
| `targetDurationSec` | `outputs[]` | Cel długości outputu |
| `synopsis` | `outputs[]` | Krótki opis outputu |

Nowe w v2: `outputKind` domyślnie `"main"` dla istniejących outputów v1; shorty dodawane przez directora jako `outputKind: "short"`.

## 14. Mapowanie na przyszły etap montażu (ffmpeg)

### 14.1. `buildOutputTimeline()` (normatywne)

Jeśli segmenty **nie mają** `outputStartSec`/`outputEndSec`, renderer **musi** wywołać `buildOutputTimeline(output)` przed montażem:

```javascript
function buildOutputTimeline(output) {
  let cursor = 0;
  const enriched = [];
  for (let i = 0; i < output.timeline.length; i += 1) {
    const seg = output.timeline[i];
    const overlap = seg.overlapSec ?? 0;
    const duration = resolveSegmentOutputDuration(seg);
    const hasExplicitOutput = seg.outputStartSec != null && seg.outputEndSec != null;

    let outputStartSec = hasExplicitOutput ? seg.outputStartSec : cursor;
    let outputEndSec = hasExplicitOutput ? seg.outputEndSec : cursor + duration;

    // J-cut: audio poprzednika wystaje pod wideo tego segmentu
    if (i > 0 && seg.audioPolicy === "from_prev" && overlap > 0) {
      const prev = enriched[i - 1];
      prev.outputEndSec = outputStartSec + overlap;
    }

    enriched.push({ ...seg, outputStartSec, outputEndSec });
    cursor = hasExplicitOutput ? outputEndSec : cursor + duration;
  }
  return enriched;
}

function resolveSegmentOutputDuration(seg) {
  if (seg.audioPolicy === "from_prev" || seg.audioPolicy === "from_next") {
    return seg.videoOutSec - seg.videoInSec;
  }
  const videoDur = seg.videoOutSec - seg.videoInSec;
  const audioDur = seg.audioOutSec - seg.audioInSec;
  switch (seg.syncMode ?? "align_start") {
    case "fit_video_to_audio": return audioDur;
    case "fit_audio_to_video": return videoDur;
    case "loop_video": return audioDur;
    default: return Math.max(videoDur, audioDur);
  }
}
```

Director **może** podać `outputStartSec`/`outputEndSec` explicite (np. przy J-cut z `overlapSec > 0`). Jeśli podane — `buildOutputTimeline()` je respektuje i waliduje spójność (brak luk, brak nakładania bez `from_prev`/`from_next`/`overlapSec`).

### 14.2. Mapowanie segment → ffmpeg

Segment v2 mapuje się na operacje:

| EditRecipe v2 | ffmpeg / montaż |
|---------------|-----------------|
| `videoRef` + `videoInSec/OutSec` | `-ss` `-t` input wideo |
| `audioRef` + `audioInSec/OutSec` | osobny input audio lub map |
| `syncMode: align_start` | `adelay` / concat z offset 0 |
| `syncMode: loop_video` | `loop` filter na wideo |
| `segmentRole: broll` | composite track V2, audio z A-roll |
| `subtitles` + `sourceClipId` | ASS z word timestamps z clip A, pozycja z output timeline |
| `outputStartSec/EndSec` | pozycja w concat / master timeline |

**Kolejność renderu (przyszłość):**

1. `buildOutputTimeline()` per output.
2. Zbuduj EDL z segmentów per output.
3. Dla każdego segmentu: wyciągnij wideo i audio według ref.
4. Normalizuj sample rate / loudness.
5. Concat z J-cuts (`from_prev`/`from_next`).
6. Burn subtitles z właściwego clipId, timing output.

---

## 15. Ryzyka i mitigacje

| Ryzyko | Prawdopodobieństwo | Wpływ | Mitigacja |
|--------|-------------------|-------|-----------|
| Reżyser nadużywa B-roll | średnie | średni | `brollStrategy: minimal`, critic |
| Zły topic match | wysokie | średni | topicIndex + threshold, human review |
| Złożony JSON | średnie | niski | walidator Zod, przykłady w prompcie |
| Klip B-roll odrzucony | średnie | wysoki | clipRole, prompt, critic rule |
| Zbyt długi brief multi-clip | wysokie | średni | clipRegistry zamiast pełnego L1 na starcie |
| Pętla fixer nie naprawia B-roll | niska | średni | kody błędów `BROLL_*` |

---

## 16. Fazy wdrożenia

### Faza A — dokumentacja i prompty (bez zmian schematu)

- Rozszerzyć `prompts/v1/director.md` o single/multi/B-roll słownie.
- Dokumentacja `--context` w README.
- **Szacunek:** 0.5 dnia.

### Faza B — schemat v2 + walidator

- `EditRecipeSchema` v2 z `audioRef`/`videoRef`.
- Migrator v1→v2.
- Testy walidatora.
- **Szacunek:** 1–2 dni.

### Faza C — clipRegistry + topicIndex + rozszerzone L1

- Krok `clip_profile`, `05a-clip-registry.json`.
- Krok `topic_index`, `05b-topic-index.json`.
- Summarizer: `brollPotential`, `topics`.
- **Szacunek:** 2–3 dni.

### Faza D — B-roll w reżyserze + critic v2

- Director brief v2 (Załącznik B).
- Director używa topicIndex do proponowania segmentów `broll`.
- Critic v2 z enum kodów błędów (§12.3).
- **Szacunek:** 2–3 dni.

### Faza E — montaż (osobny moduł / repo)

- Mapowanie segmentów v2 na ffmpeg.
- Poza scope obecnego agenta.

---

## 17. Kryteria akceptacji

### 17.1. Single clip

- [ ] Pipeline z 1 plikiem produkuje EditRecipe bez `whole_clip` excluded.
- [ ] Segmenty mają poprawne cięcia fillerów.
- [ ] Min. 16:9 + 9:16.

### 17.2. Multi-clip z wykluczeniem

- [ ] Reżyser potrafi dodać `excluded` z `clipId` i `exclusionType: whole_clip`.
- [ ] Krytyk nie flaguje wykluczenia outtakes jako błąd.

### 17.3. Cross-clip B-roll

- [ ] Co najmniej 1 segment z `audioRef.clipId !== videoRef.clipId`.
- [ ] `subtitles.sourceClipId` wskazuje klip z mową.
- [ ] Walidator akceptuje poprawny segment; odrzuca brak `audioInSec`.

### 17.4. B-roll pool bez mowy

- [ ] Klip bez mowy dostaje `clipRole: broll_pool`, nie `whole_clip` excluded.
- [ ] Sceny z tego klipu pojawiają się tylko w `segmentRole: broll`.

### 17.5. Kompatybilność

- [ ] Istniejące receptury v1.0 migrują się do v2 bez utraty danych.
- [ ] Migrator usuwa `sourceRef` i `audioOffsetSec` z outputu v2.

### 17.6. Oczekiwania synchronizacji (z §4.3)

- [ ] Cross-clip B-roll wskazuje ujęcie i zakres mowy z tolerancją ±3s (intent + timeRange).
- [ ] EditRecipe nie gwarantuje frame-accurate sync — to akceptowalne ograniczenie MVP.
- [ ] Critic nie flaguje ±3s jako ERROR (tylko SUGGESTION przy > 5s rozjazdu tematycznego).

### 17.7. Shorts standalone

- [ ] Co najmniej 1 short (9:16) jako osobny highlight, max 60s.
- [ ] Short może reuse scen z 16:9 (SR3).

### 17.8. Scene registry i topicIndex

- [ ] Duplikat sceneId w tym samym output bez `allowBrollReuse` → walidator ERROR.
- [ ] Director nie dodaje scen spoza topicIndex jako B-roll.
- [ ] `clip_profile` produkuje `05a-clip-registry.json` z `roleConfidence`/`roleSource`.

---

## 18. Decyzje zamknięte (byłe otwarte pytania)

Wszystkie pytania z review v1.0 zostały rozstrzygnięte. Szczegóły normatywne w sekcjach wskazanych.

| # | Pytanie | Decyzja | Sekcja |
|---|---------|---------|--------|
| 1 | Czy `broll_pool` może być reuse w wielu segmentach tego samego outputu? | **TAK** — gdy `allowBrollReuse: true` na segmencie lub w `batchContext`. Bez flagi → ERROR. Critic WARNING przy > 3× reuse. | §9.3 |
| 2 | Muzyka tła (`audioPolicy: external`)? | **Poza scope v2** — deferred v2.1 wraz z `transition`/`bridge`. | §7.1, §7.2 |
| 3 | Automatyczne `clipRole` vs kontekst użytkownika? | Rule-based pre-pass + opcjonalny LLM dla `visualSummary`. Precedencja: CLI context > clip_profile > director. | §6.2, §11.2 |
| 4 | Shorts z wielu klipów? | **Standalone highlights** — osobna narracja, max 60s, reuse scen między formatami dozwolony. | §8.3 |
| 5 | Język inny niż polski — topicIndex cross-language? | MVP: język transkryptu. Cross-language — deferred. | §10.5 |
| 6 | Maksymalna liczba segmentów B-roll? | Domyślnie **30** per output (`batchContext.maxBrollSegmentsPerOutput`). Przekroczenie → WARNING. | §6.6, V20 |
| 7 | Scene registry blokuje B-roll między 16:9 i 9:16? | **NIE** — reuse między formatami jest zamierzony i dozwolony (SR3). | §9.3 |

---

## Załącznik A: Przykładowy EditRecipe v2 (skrót)

```json
{
  "version": "2.0",
  "batchId": "day1111",
  "batchContext": {
    "inputMode": "multi_clip_day",
    "theme": "vlog 11 listopada",
    "brollStrategy": "match_speech_topics",
    "brollMatchThreshold": 0.55,
    "qualityOverQuantity": true,
    "requiredFormats": ["16:9", "9:16"],
    "shortsStrategy": "standalone_highlights",
    "shortsMaxDurationSec": 60,
    "allowBrollReuse": false
  },
  "clipRegistry": [
    {
      "clipId": "clip01",
      "fileName": "01_walk.MOV",
      "durationSec": 600,
      "sortIndex": 0,
      "clipRole": "aroll_primary",
      "roleConfidence": 0.9,
      "roleSource": "clip_profile",
      "hasSpeech": true,
      "speechWordCount": 4200
    },
    {
      "clipId": "clip03",
      "fileName": "03_food_broll.MOV",
      "durationSec": 124.5,
      "sortIndex": 2,
      "clipRole": "broll_pool",
      "roleConfidence": 0.88,
      "roleSource": "clip_profile",
      "hasSpeech": false,
      "speechWordCount": 0,
      "topics": ["jedzenie"]
    },
    {
      "clipId": "clip04",
      "fileName": "04_drone.MOV",
      "durationSec": 90,
      "sortIndex": 3,
      "clipRole": "broll_pool",
      "roleConfidence": 0.85,
      "roleSource": "clip_profile",
      "hasSpeech": false,
      "speechWordCount": 0,
      "topics": ["krajobraz"]
    }
  ],
  "outputs": [
    {
      "outputId": "youtube_16x9",
      "format": "16:9",
      "outputKind": "main",
      "title": "Dzień 66 — jedzenie i miasto",
      "timeline": [
        {
          "segmentId": "s1",
          "segmentRole": "aroll",
          "videoRef": { "clipId": "clip01", "sceneId": "clip01_scene002" },
          "audioRef": { "clipId": "clip01", "sceneId": "clip01_scene002" },
          "videoInSec": 0,
          "videoOutSec": 30,
          "audioInSec": 0,
          "audioOutSec": 30,
          "audioPolicy": "from_video_ref",
          "outputStartSec": 0,
          "outputEndSec": 30
        },
        {
          "segmentId": "s2",
          "segmentRole": "broll",
          "videoRef": { "clipId": "clip03", "sceneId": "clip03_scene001" },
          "audioRef": { "clipId": "clip01", "sceneId": "clip01_scene002" },
          "videoInSec": 5,
          "videoOutSec": 11,
          "audioInSec": 30,
          "audioOutSec": 36,
          "audioPolicy": "from_audio_ref",
          "syncMode": "align_start",
          "outputStartSec": 30,
          "outputEndSec": 36,
          "subtitles": {
            "policy": "word_by_word",
            "sourceClipId": "clip01",
            "outputStartSec": 30,
            "outputEndSec": 36,
            "style": "default"
          },
          "intent": "Mowa o restauracji — ujęcia jedzenia"
        },
        {
          "segmentId": "s3",
          "segmentRole": "broll",
          "videoRef": { "clipId": "clip04", "sceneId": "clip04_scene001" },
          "audioRef": { "clipId": "clip01", "sceneId": "clip01_scene005" },
          "videoInSec": 0,
          "videoOutSec": 8,
          "audioInSec": 120,
          "audioOutSec": 128,
          "audioPolicy": "from_audio_ref",
          "syncMode": "align_start",
          "outputStartSec": 36,
          "outputEndSec": 44,
          "intent": "Drone pod narracją — natywne audio drona wyciszone"
        }
      ]
    },
    {
      "outputId": "short_01",
      "format": "9:16",
      "outputKind": "short",
      "title": "Highlight: pierwsza restauracja",
      "timeline": []
    }
  ],
  "excluded": [
    {
      "clipId": "clip07",
      "exclusionType": "whole_clip",
      "usableAsBroll": false,
      "reason": "Outtakes",
      "confidence": 0.95
    }
  ]
}
```

---

## Załącznik B: Director brief v2 — JSON schema

Struktura `buildDirectorBrief()` v2 dostarczana do directora:

```json
{
  "version": "2.0",
  "batchContext": { },
  "inputMode": "multi_clip_day",
  "sessionSummary": "L3 text",
  "segmentSummaries": [],
  "clipRegistry": [],
  "topicIndex": {
    "topics": [
      {
        "topicId": "topic_001",
        "label": "restauracja",
        "wordIds": ["clip01_w0042"],
        "timeRange": { "clipId": "clip01", "startSec": 44.0, "endSec": 58.0 },
        "matchingScenes": [
          { "sceneId": "clip03_scene002", "score": 0.85, "reason": "visual: jedzenie" }
        ]
      }
    ]
  },
  "sceneMap": [
    {
      "sceneId": "clip01_scene002",
      "clipId": "clip01",
      "startSec": 0,
      "endSec": 45,
      "hasSpeech": true,
      "brollPotential": 0.1,
      "topics": []
    }
  ],
  "brollCandidates": [
    {
      "sceneId": "clip03_scene002",
      "clipId": "clip03",
      "brollPotential": 0.9,
      "topics": ["jedzenie"],
      "visualQuality": "high"
    }
  ],
  "fillerStats": {},
  "excludedHints": [],
  "constraints": {
    "requiredFormats": ["16:9", "9:16"],
    "brollMatchThreshold": 0.55,
    "maxBrollSegmentsPerOutput": 30,
    "shortsMaxDurationSec": 60,
    "sceneRegistryRules": "SR1-SR6"
  }
}
```

#### Tabela pól — `DirectorBriefV2`

| Pole | Typ | Wymagane | Opis |
|------|-----|----------|------|
| `version` | string | tak | `"2.0"` |
| `batchContext` | object | tak | Kontekst batchu |
| `inputMode` | enum | tak | Rozstrzygnięty inputMode (§8.2) |
| `sessionSummary` | string | tak | L3 |
| `segmentSummaries` | array | tak | L2 |
| `clipRegistry` | array | tak | Z `05a-clip-registry.json` |
| `topicIndex` | TopicIndex | tak | Z `05b-topic-index.json` |
| `sceneMap` | array | tak | Sceny z L1 metadanymi |
| `brollCandidates` | array | tak | Sceny z brollPotential ≥ 0.5 |
| `fillerStats` | object | tak | Per scena |
| `excludedHints` | array | nie | Propozycje wykluczeń z clip_profile |
| `constraints` | object | tak | Twarde reguły dla directora |

Director **nie może** ignorować `topicIndex` ani wymyślać scen spoza `brollCandidates` / `topicIndex.matchingScenes`.

---

## Załącznik C: Słownik pojęć

| Termin | Definicja |
|--------|-----------|
| A-roll | Główny materiał narracyjny (zwykle z mową) |
| B-roll | Materiał ilustracyjny pod narrację |
| J-cut | Audio następnej sceny zaczyna się przed wideo |
| L-cut | Wideo następnej sceny przed audio |
| clip pool | Zbiór klipów o danej roli (np. broll_pool) |
| drill-down | Drugi pass AI z detalami L0/L1 dla wybranych scen |
| `buildOutputTimeline` | Funkcja wyznaczająca outputStartSec/EndSec z segmentów |
| EditRecipe | JSON receptura montażowa (output agenta) |
| `requiredFormats` | Kanoniczna lista wymaganych formatów (alias: deprecated `minOutputs`) |

---

## Załącznik D: EditRecipe v2.1 — warstwa kreatywności

> Status: zaimplementowane w kodzie (2026-06-26)  
> Pełny plan: [`docs/CREATIVITY_TECHNIQUES_V21_PLAN.md`](./CREATIVITY_TECHNIQUES_V21_PLAN.md)

### Rozszerzenia schematu

- `version`: `"2.0" | "2.1"` — v2.0 bez `creativeMoments` pozostaje ważny
- `creativityProfile`: `{ level, allowMidSentenceCuts, techniquePack, maxTechniqueDensityPerMin }`
- `creativeMoments[]`: momenty montażowe z `techniqueId`, zakresem output, `params`, `reason`

### Katalog technik

- Pliki JSON w `techniques/` + JSON Schema (`techniques/_schema.json`)
- Loader: `loadTechniqueCatalog({ pack, platforms })` — pack filtruje `enabledTechniqueIds`
- `defaultCreativityLevel` w packu nadpisuje domyślny level gdy użytkownik go nie podał

### Poziomy kreatywności

| level | Zachowanie |
|-------|------------|
| `safe` | Tylko `cut_on_beat`, `crossfade`, podstawowe zoomy; obniżony budżet |
| `balanced` | Domyślny pack YouTube |
| `bold` | Mid-sentence cuts, techniki wymagające `level≥bold` |
| `shorts` | Pack `shorts_energy`, wyższa gęstość |

Porównanie leveli: `safe < balanced < bold < shorts` (minimum level gate dla `requiresCreativityLevel`).

### Walidacja V21

| Kod | Reguła |
|-----|--------|
| V21-01 | `techniqueId` w załadowanym katalogu |
| V21-02 | `params` w zakresach |
| V21-03 | Gating level / `allowMidSentenceCuts` / safe whitelist |
| V21-04 | Min gap end→start (ta sama technika + camera budget) |
| V21-05 | `maxPerOutputMinutes` per `outputId`, budżet zoom/density |
| V21-06 | `forbiddenOnSegmentRole` |
| V21-07 | `requiresSpatialAnchor` (warning bez spatial index) |
| V21-08 | Niepusty `reason` |
| V21-09 | `anchorWordId` istnieje w word index i ma format `clipId_wNNNN` |
| V21-10 | `spatialRef.sceneId` w spatial index; bbox zgodny z primary anchor (warning) lub error gdy brak anchorów |

Budżet camera obejmuje wszystkie techniki `category: camera` (chyba że `countsTowardZoomBudget: false`).

### Integracja agentów

- **Director** — wstrzykuje `techniqueCatalog` + `creativityBudget` (także drill-down)
- **Critic** — heurystyki V21 + skrócony katalog przy v2.1
- **Fixer** — `prompts/v2/fixer.md` dla recipe v2.0/v2.1

---

## Załącznik E: EditRecipe v2.2 — gramatyka retencji shortów

> Status: zaimplementowane w kodzie (2026-06-26)  
> Pełny plan: [`docs/SHORTS_RETENTION_V22_PLAN.md`](./SHORTS_RETENTION_V22_PLAN.md)

### Rozszerzenia schematu

- `version`: `"2.2"` — rozszerza v2.1 o retencję shortów
- `shortsRetentionProfile`: cadence hooka i beatów, pack `shorts_retention_2026`
- `creativeMoments[].retentionRole`: `hook` | `beat` | `payoff`
- `textOverlays`: `style` (`hook_large`, `emphasis`, `chapter_card`, …), `role` (`hook`, `retention_beat`, `payoff`, `cta`)

### Kategoria technik `graphics`

| id | Rola |
|----|------|
| `hook_title_overlay` | Duży napis 0–3 s |
| `hook_visual_punch` | Najmocniejszy kadr w hook window |
| `emphasis_text` | Średni napis na punchline |
| `chapter_card` | Karta rozdziału / licznik |
| `pattern_interrupt` | Cut + zoom lub tekst — reset uwagi |
| `retention_beat` | Meta-zabieg beat retencji |

### Walidacja V22 (tylko `outputKind: short`)

| Kod | Reguła |
|-----|--------|
| V22-01 | Hook moment w `[0, hookWindowSec)` |
| V22-02 | Hook overlay w hook window |
| V22-03 | Min. liczba beatów (skalowana z długością) |
| V22-04 | Max luka między momentami ≤ interval + tolerance |
| V22-05 | Hook overlay tylko w hook window |
| V22-06 | Graphics `requiresOutputKind: short` tylko na short |

Severity: V22-01, V22-02, V22-04 → error przy `level: shorts`; warning przy balanced.

### Integracja agentów

- **Director** — `shortsRetentionProfile`, `retentionGrammarSummary`, pack filter
- **Critic** — heurystyki V22 + V21
- **Fixer** — naprawy V22 w `prompts/v2/fixer.md`

---

*Koniec dokumentu v1.3 — v2.2 shorts retention appendix.*
