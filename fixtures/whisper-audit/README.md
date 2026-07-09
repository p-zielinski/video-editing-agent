# Whisper audit fixtures

Regression suite for Whisper transcription quality on Polish vlog speech, profanity handling, English proper nouns, and meta-commands.

## Layout

```
fixtures/whisper-audit/
├── catalog.json          # Index of all cases
└── cases/
    └── <case-id>/
        ├── case.json              # Case metadata and spoken transcript
        ├── expected.json          # Token/recall expectations for the benchmark
        └── whisper-response.json  # Saved Whisper API response (fixture replay mode)
```

### `catalog.json`

| Field | Description |
|-------|-------------|
| `version` | Catalog schema version |
| `description` | Human-readable summary |
| `cases[]` | List of case entries |
| `cases[].caseId` | Stable identifier (matches folder name) |
| `cases[].category` | Grouping: `profanity`, `en-proper-nouns`, `meta-commands`, … |
| `cases[].dir` | Relative path to the case folder |

### Case folder

**`case.json`** — input definition:

| Field | Description |
|-------|-------------|
| `caseId` | Same as catalog entry |
| `category` | Case category |
| `title` | Short label |
| `spokenTranscript` | Ground-truth spoken text (for fixture mode / expectations) |
| `language` | ISO language hint (`pl`, `en`, …) |
| `tags` | Optional tags for filtering |
| `audio.optional` | When `true`, live mode may skip missing audio files |
| `promptVariant` | Whisper prompt variant key |

**`expected.json`** — pass/fail criteria consumed by `src/lib/whisper-benchmark.js`:

| Field | Description |
|-------|-------------|
| `tokenPolicy` | How tokens are matched (`wordCore`, …) |
| `mustIncludeTokens` | Tokens that must appear in the transcript |
| `minTokenRecall` | Minimum recall vs. spoken transcript |
| `orderedSubsequence` | Tokens that must appear in order |
| `allowEmptyWords` | Whether an empty word list is acceptable |

**`whisper-response.json`** — raw Whisper response saved for offline replay (`benchmark:whisper:fixture`).

## Commands

```bash
# Live API (requires OPENAI_API_KEY)
npm run benchmark:whisper

# Replay saved responses — no API calls
npm run benchmark:whisper:fixture
```

Useful flags (see `scripts/whisper-benchmark.js`):

```bash
npm run benchmark:whisper:fixture -- --case profanity-literal
npm run benchmark:whisper:fixture -- --category profanity
npm run benchmark:whisper:fixture -- --json --fail-on-regression
```

## Code references

| Area | Path |
|------|------|
| Benchmark engine | `src/lib/whisper-benchmark.js` |
| CLI script | `scripts/whisper-benchmark.js` |
| Contract tests | `tests/contracts/whisper-audit-contract.test.js` |
| Transcription | `src/lib/transcribe.js` |

## Adding a case

1. Create `cases/<case-id>/` with `case.json`, `expected.json`, and (after a live run) `whisper-response.json`.
2. Register the case in `catalog.json`.
3. Run `npm run benchmark:whisper:fixture` and ensure contract tests pass.
