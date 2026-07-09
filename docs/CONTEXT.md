# batchContext — pola kontekstu batcha

Pełna referencja pól `batchContext` używanych w orchestratorze (`src/pipeline/orchestrator.js`), CLI (`src/cli.js`) i recepturze (`BatchContextV2Schema` w `src/schemas/edit-recipe-v2.js`).

Powiązane: [`README.md`](../README.md), [`docs/PIPELINE.md`](PIPELINE.md).

---

## Jak ustawić

| Sposób | Przykład |
|--------|----------|
| JSON w `--context` | `--context '{"profanityPolicy":"mute","expectedTerms":["Elden Ring"]}'` |
| Tekst wolny | `--context "vlog dzień 66/100"` → trafia do `notes` |
| Tokeny DSL | `creativity: bold`, `shorts: retention` (parsowane w directorze) |
| Manifest | `00-manifest.json` → `batchContext` zapisywany przy ingest, używany m.in. przez transcribe |

Orchestrator buduje domyślny kontekst w `resolveBatchContext()` i zapisuje go w manifeście. Pola z JSON w `--context` nadpisują domyślne.

Pola wprowadzone lub rozszerzone w v2 (pełna lista w tabeli poniżej): `formatsSource`, `sortBy`, `targetDurationSec`, `musicBed`, `skipDrillDown`, `superDirectorDurationThresholdSec`, `superDirectorMaxSegments`.

---

## Pola — tabela

| Pole | Typ | Domyślnie | Gdzie używane |
|------|-----|-----------|---------------|
| `inputMode` | `single_clip` \| `multi_clip_day` \| `multi_clip_collection` | auto: 1 klip → `single_clip`, 2+ → `multi_clip_day` | ingest sort, director brief, walidatory |
| `requiredFormats` | `["16:9", "9:16"]` | CLI `--min-outputs` lub L3 po abstract | outputs receptury, render, quality report |
| `formatsSource` | `cli` \| `context` \| `l3` \| `default` | — (ustawiane po abstract) | log orchestratora; skąd wzięto formaty |
| `notes` | string | tekst `--context` (gdy nie JSON) | director, critic, audio mix heurystyki |
| `theme` | string | — | chapter hints, rewind overlay, audio mix |
| `dayLabel` | string | — | rewind overlay (`buildRewindOverlayText`) |
| `challengeDay` | string | — | metadane batcha |
| `targetPlatforms` | string[] | `[]` | critic/fixer brief |
| `qualityOverQuantity` | boolean | `true` | walidator V21, director |
| `allowWholeClipExclusion` | boolean | `true` | director |
| `brollStrategy` | `match_speech_topics` \| `chronological` \| `director_choice` \| `minimal` | `match_speech_topics` | B-roll sync enricher, walidatory |
| `brollMatchThreshold` | number 0–1 | `0.55` | topic index, quality report |
| `allowBrollReuse` | boolean | `false` | scene registry, chapter hints, retention |
| `maxBrollSegmentsPerOutput` | int | `30` | walidator V21 |
| `shortsStrategy` | `standalone_highlights` | `standalone_highlights` | schemat |
| `shortsMaxDurationSec` | number | `60` | retention enricher, technique budget |
| `targetDurationSec` | number | — | retention (fallback długości main) |
| `minOutputs` | string[] | — | legacy alias formatów (migracja v1→v2) |
| `sortBy` | `mtime` \| `creation_time` \| `name` | auto przy multi-clip | ingest |
| `profanityPolicy` | `bleep` \| `mute` \| `cut` \| `off` | `bleep` | transcribe (tagging), `enrichRecipeProfanity` |
| `profanitySubtitleMode` | `partial` \| `full` | `partial` | transcribe — cenzura napisów (`config/profanity-pl.json`) |
| `expectedTerms` | string[] | `[]` | Whisper prompt, korekta transkryptu, fingerprint cache słów |
| `skipDrillDown` | boolean | `false` | `shouldRunDirectorDrillDown` — wyłącza drugi pass directora |
| `publishVoice` | object | patrz niżej | thumbnails, publish |
| `aiVideoEnabled` | boolean | `false` | krok `ai_video`; CLI `--ai-video` wymusza `true` |
| `aiVideoMaxPerBatch` | int | `1` | hook planner |
| `aiVideoMaxDurationSec` | number | `5` | hook planner, walidator AI hook |
| `aiVideoGenerateAudio` | boolean | `false` | Kling — audio w generowanym klipie |
| `aiVideoTargetOutputs` | `["9:16"]` | `["9:16"]` | które formaty dostają hook |
| `narrativeProfile` | object | — | enrichery, walidatory narracyjne (alternatywa: pole `recipe.narrativeProfile`) |
| `musicBed` | boolean | — | `audio-mix-plan.js` — `false` wyłącza muzykę |

### `publishVoice` (domyślnie z `resolvePublishVoice`)

| Pole | Domyślnie | Rola |
|------|-----------|------|
| `thumbnailVoice` | `loud` | ton nagłówków na miniaturach |
| `titleVoice` | `lowercase_casual` | warianty tytułu |
| `descriptionVoice` | `lowercase_casual` | opis YouTube |
| `descriptionRules` | max 2 zdania, lowercase, bez `!` i `?` | formatowanie opisu |

---

## Pola spoza `batchContext` (powiązane)

| Stała / pole | Wartość domyślna | Opis |
|--------------|------------------|------|
| `SUPER_DIRECTOR_MAX_SEGMENT_PICKS` | `10` | fallback gdy brak `batchContext.superDirectorMaxSegments` |
| `SUPER_DIRECTOR_DURATION_THRESHOLD_SEC` | `600` | fallback gdy brak `batchContext.superDirectorDurationThresholdSec` |

### Super Director — `batchContext`

| Pole | Domyślnie | Rola |
|------|-----------|------|
| `superDirectorDurationThresholdSec` | `600` | próg czasu (s) — powyżej włącza Super Director |
| `superDirectorMaxSegments` | `10` | max segmentów L2 wybieranych przez Super Director |
| `forceClassicDirector` | `false` | gdy `true` — zawsze klasyczny director (jeden GPT), nawet przy długim materiale lub wielu L2 |

---

## Przykłady

```bash
# Wulgaryzmy — wyciszenie zamiast bleepu
node src/cli.js run --input ./inbox/day --context '{"profanityPolicy":"mute"}'

# Nazwy własne dla Whispera i korekty OCR
node src/cli.js run --input ./inbox/gaming --context '{"expectedTerms":["Elden Ring","FromSoftware"]}'

# AI hook + short
node src/cli.js run --input ./inbox/short --ai-video --context '{"requiredFormats":["9:16"],"aiVideoEnabled":true}'

# Bez drill-down directora (oszczędność GPT)
node src/cli.js direct --batch-id abc12345 --context '{"skipDrillDown":true}'

# Długi single-clip — wymuś klasycznego directora zamiast Super Director
node src/cli.js direct --batch-id abc12345 --context '{"forceClassicDirector":true}'
```
