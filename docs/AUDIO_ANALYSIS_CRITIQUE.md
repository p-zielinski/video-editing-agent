# Audio Analysis Layer — Critique

> Data: 2026-06-26  
> Plan: `docs/AUDIO_ANALYSIS_PLAN.md`  
> **Werdykt: 5/10 warstwa audio** — infrastruktura OK, sygnał dla reżysera słaby

## Scores

| Wymiar | Ocena |
|--------|-------|
| Beat detection | 3/10 |
| Voice energy → director | 4/10 |
| Silence vs Whisper fillers | 5/10 |
| Music bed selection | 4/10 |
| audioMixPlan vs render | 5/10 |
| creativeMoments integracja | 4/10 |
| Default flip | **8/10** |
| Test confidence | 4/10 |
| **Ogółem** | **5/10** |

## Co działa ✅

- Krok 3 `audio_analysis`, artefakty `01b` + `05d`
- loudnorm -18 na ścieżce Whisper
- Domyślnie **live**: vision, face, audio (`--fast` = wszystko stub)
- Director: `audioIndex`, `audioMixDefaults`, merge `audioMixPlan`
- V21-11 beat sync (warning)
- 415 + 10 testów

## Krytyczne problemy

1. **beat_track na mowie** — librosa „beaty” to rytm sylab, nie muzyka → mylące dla `cut_on_beat`
2. **energyCurve nie trafia do briefu** — director nie widzi hype/calm
3. **cutSuggestions / silenceGaps** — nie w promptcie LLM
4. **ffmpeg fallback** — fałszywe beaty ze stub
5. **Katalog muzyki** — 3 placeholdery, brak plików MP3
6. **Critic bez audioIndex** — pętla review nie widzi beatów/mixu
7. **Brak E2E** dla kroku `audio_analysis`

## P0 do naprawy (→ 7–8/10 audio)

1. Speech onsets/pauses zamiast beat_track na voice; ffmpeg: `beats: []`
2. Brief: `cutSuggestions`, top energy peaks, capped `beatTimes`
3. Fusion dead air: RMS + przerwy między słowami
4. Critic + drill-down: `audioIndex` summary
5. V21-12 music_swell bez musicBed; V21-13 silence_beat
6. E2E mini-day przez `audio_analysis`
7. Napraw `silenceRatio` w inferMood

## P1

- Batch music picker (short vs main)
- Recompute audioMixPlan.segments po fixerze
- Golden WAV + test librosa
