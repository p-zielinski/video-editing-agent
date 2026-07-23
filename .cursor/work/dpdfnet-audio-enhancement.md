# DPDFNet audio enhancement

> Last updated: 2026-07-19
> Status: done

## Problem & goal

Zastąpić domyślny denoiser DeepFilterNet przez DPDFNet (Dual-Path DeepFilterNet, Ceva) przy zachowaniu jawnego fallbacku `deepfilternet` i `ffmpeg`.

## Scope

- **In scope:** provider CLI `dpdfnet`, config/env, recovery, docs, testy jednostkowe
- **Out of scope:** usunięcie DeepFilterNet, streaming API, A/B jakości na produkcji

## Key files & context

| Area | Path | Role |
|------|------|------|
| Provider | `src/lib/audio-enhancement/providers/dpdfnet.js` | spawn `dpdfnet enhance` |
| Router | `src/lib/audio-enhancement/providers/index.js` | routing providerów |
| Config | `src/lib/audio-enhancement/config.js` | env vars, default `dpdfnet` |
| Recovery | `src/lib/recovery/error-codes.js`, `templates.js` | `AUDIO_ENH_DPDFNET_FAILED` |
| Docs | `docs/PIPELINE.md`, `.env.example` | setup i env |

## Decisions

- 2026-07-19: Domyślny provider `dpdfnet`, model `dpdfnet8_48khz_hr` (48 kHz pipeline)
- 2026-07-19: `DPDFNET_ATTN_LIMIT_DB=12` (upstream recommendation)
- 2026-07-19: DeepFilterNet pozostaje jako `AUDIO_ENHANCEMENT_PROVIDER=deepfilternet`

## Progress

- [x] Provider `dpdfnet.js` + config + router
- [x] Error code + recovery templates
- [x] `.env.example`, `PIPELINE.md`, `python/requirements.txt` comment
- [x] Testy provider/router/classify
- [ ] Lokalna weryfikacja na prawdziwym batchu (wymaga `pip install dpdfnet`)

## Next steps

1. `pip install 'dpdfnet>=0.6,<1'`
2. `dpdfnet download dpdfnet8_48khz_hr`
3. Uruchomić batch z `--from-step audio_enhancement` na clipie z szumem
4. Porównać SNR before/after w `07a-audio-enhancement-*.json` i odsłuch

## Blockers / open questions

- Python ≥3.11 wymagany przez pakiet `dpdfnet`
- Pierwszy run pobiera modele z Hugging Face

## Verification

```bash
npm test -- src/lib/audio-enhancement/providers/dpdfnet.test.js \
  src/lib/audio-enhancement/providers/index.test.js \
  src/lib/audio-enhancement/providers/deepfilternet.test.js \
  src/lib/recovery/classify-error.test.js
```

Lokalny smoke (po instalacji dpdfnet):

```bash
dpdfnet enhance noisy.wav enhanced.wav --model dpdfnet8_48khz_hr --attn-limit-db 12
node src/cli.js run --batch-id <id> --from-step audio_enhancement
```

Legacy DeepFilterNet:

```bash
AUDIO_ENHANCEMENT_PROVIDER=deepfilternet node src/cli.js run --batch-id <id> --from-step audio_enhancement
```
