# Delivery engagement calibration dataset

Template for collecting editor ratings used to calibrate `delivery_analysis.py` heuristic weights.

## Goal

50–100 in-domain clips with 5-point ratings for:

- **engagement** — how engaging is the vocal delivery?
- **monotony** — how flat/monotone does it sound? (higher = more monotone)
- **naturalness** — does any repair sound natural?
- **editability** — how actionable are the suggested repairs?

## File format

Add one JSON object per line to `ratings.jsonl`:

```json
{"clipId":"clip01","speakerId":"spk_a","ratings":{"engagement":2,"monotony":4,"naturalness":5,"editability":4},"notes":"flat mid-section, good after trim","split":"train"}
```

## Splits

- **train** — fit calibration weights
- **val** — tune thresholds
- **test** — speaker-disjoint final evaluation

## Metrics

Report on held-out test set:

- Spearman rank correlation vs engagement rating
- False-positive rate for `flat` grade (target < 30% on pilot set)
- Speaker-disjoint evaluation (never train and test on same speaker)

## Usage (future)

```bash
python python/calibrate_delivery_weights.py --input data/delivery-calibration/ratings.jsonl
```

Until enough labels exist, production uses fixed heuristic weights in `delivery_analysis.py`.
