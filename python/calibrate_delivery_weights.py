#!/usr/bin/env python3
"""Calibrate delivery_analysis heuristic weights from editor ratings (jsonl)."""

import argparse
import json
import sys
from pathlib import Path


def load_ratings(path: Path) -> list:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rows.append(json.loads(line))
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Calibrate delivery engagement weights")
    parser.add_argument("--input", required=True, help="Path to ratings.jsonl")
    parser.add_argument("--min-samples", type=int, default=20)
    args = parser.parse_args()

    ratings = load_ratings(Path(args.input))
    if len(ratings) < args.min_samples:
        print(
            json.dumps({
                "status": "insufficient_data",
                "count": len(ratings),
                "minSamples": args.min_samples,
                "message": "Collect more ratings in data/delivery-calibration/",
            }),
            file=sys.stderr,
        )
        sys.exit(1)

    # Placeholder: future logistic regression on exported features per clip.
    print(json.dumps({
        "status": "not_implemented",
        "count": len(ratings),
        "message": "Weights remain defaults in delivery_analysis.py until calibration model is trained",
    }))


if __name__ == "__main__":
    main()
