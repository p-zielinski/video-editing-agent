# Audyt flow montażu AI — 2026-06-29 (aktualizacja #5)

> Pełny przegląd pipeline + render. **LUT/colorGrade poza zakresem** — nie planowane na razie.

## Zaimplementowano (sesja 5)

| Zmiana | Wpływ |
|--------|--------|
| **`enrich` CLI** | Ponowny pass enricherów bez GPT (`recipe-enrich.js`) |
| **`run --render`** | Inbox → receptura → render w jednej komendzie |
| **`--render-profile`** | Presety `preview` / `iterate` / `production` |
| **CHR integracja** | Testy `validateRecipeV2` + V25-CHR-01/03 |
| **teaseSceneId fix** | Wyłączenie tylko przy rewind intro / moment (nie przy błędnej chronologii) |
| **E2E pipeline → render** | Mock pipeline + stub FFmpeg (`full-pipeline-mocked.test.js`) |

### Nowe komendy

```bash
# One-shot: analiza + reżyseria + montaż
node src/cli.js run --input ./inbox/day --context "vlog" --render --render-profile preview

# Re-enrich po zmianie indeksów (bez GPT)
node src/cli.js enrich --batch-id <id> --source draft --target final --force

# Render z presetem (szybki podgląd)
node src/cli.js render --batch-id <id> --render-profile preview --force
```

### Profile renderu (`src/render/render-config.js`)

| Profil | Zachowanie |
|--------|------------|
| `preview` | draft + skip creative/subs/overlays/audio/color |
| `iterate` | draft + skip subs/overlays + keep-tmp |
| `production` | pełny łańcuch (domyślny) |

## Stan funkcji (skrót)

| Funkcja | Status |
|---------|--------|
| Enrich deterministyczny | **Done** + CLI `enrich` |
| Render resume / skip / profile | **Done** |
| CHR-01/02 error gate | **Done** |
| Pipeline → render E2E | **Done** (stub FFmpeg) |
| LUT / colorGrade | **Out of scope** (użytkownik nie korzysta) |

## Nadal do zrobienia

### P0

1. **Validation gate E2E** — test `validationFailed: true` + exit code 2 z CLI
2. **Crossfade + J/L** — validator + prompt mutual exclusion
3. **Fixer fixable CHR-03 / BROLL-04/05** warnings
4. **README / FORMATY** — v2.5 CHR, enrich, render-profile (bez LUT)

### P1

5. **E2E z prawdziwym FFmpeg** na output mock pipeline (dziś stub)
6. **Critic-fixer E2E** dla CHR / brollStrategy
7. **CI job** `npm run test:e2e` z ffmpeg

### P2

8. Smart crop 9:16→16:9
9. Vision match_cut, karaoke subtitles
10. Live batch checklist w CI

## Weryfikacja

```bash
node --test src/cli.test.js src/render/render-config.test.js \
  src/pipeline/steps/recipe-enrich.test.js src/validators/recipe-v2-validator.test.js \
  tests/e2e/full-pipeline-mocked.test.js tests/editorial/retention-enrich.test.js \
  src/validators/chronology.test.js
```

## Powiązane

- [`FORMATY_AI_I_GOTOWOSC_MONTAZU.md`](./FORMATY_AI_I_GOTOWOSC_MONTAZU.md)
- Handoff: `~/.cursor/work/format-aspect-pipeline.md`
