# Vision 4K OOM fix

> Last updated: 2026-07-19
> Status: done

## Problem & goal

Qwen/Florence OOM on 3840×2160 keyframes (Metal ~53 GB alloc). Done = downscale before inference (max side 1280), resume batch from vision without regenerating keyframes.

## Scope

- **In scope:** `vlm_image_utils.py`, `vision_qwen.py`, `vision_florence.py`, env/docs, tests
- **Out of scope:** FFmpeg keyframe resize at extract time

## Key files

| Area | Path | Role |
|------|------|------|
| Resize helper | `python/vlm_image_utils.py` | `load_rgb_resized`, bbox scale, `VISION_MAX_SIDE` |
| Qwen | `python/vision_qwen.py` | temp JPEG before mlx-vlm generate |
| Florence | `python/vision_florence.py` | resize + bbox back to orig WxH |
| Tests | `python/vlm_image_utils_test.py` | resize + bbox unit tests |

## Decisions

- 2026-07-19: Downscale at inference only (not keyframes on disk); default `VISION_MAX_SIDE=1280`; fingerprint unchanged (resume 14 cached vision clips OK).

## Progress

- [x] vlm_image_utils helper
- [x] vision_qwen + vision_florence
- [x] docs/env/tests
- [x] handoff

## Resume batch 51cd206d

1. Zatrzymaj bieżący run (Ctrl+C jeśli jeszcze leci).
2. Uruchom:

```bash
npm run full -- --batch-id 51cd206d --from-step vision \
  --context "wyjazd w góry, na dzień przed moimi 30stymi urodzinami, próba podejścia do tego jak do rozliczenia się z lat 20stych i próba zyczenia sobie lepszych lat 30stych, lata 20 to moze nie czas porazek ale z pewnością niewykorzystanych szans"
```

- clip07–12, 14–15, 18–23: cache (skip)
- pozostałe 26 klipów 4K: vision na ≤1280px, potem objects
- `clip16` (83 klatek): najdłuższy, ale bez 53 GB OOM
- Nie używaj `--force` na vision, chyba że chcesz przeliczyć 14 gotowych klipów

## Verification

```bash
cd python && python3 vlm_image_utils_test.py -v
```
