"""Shared image resize helpers for vision / object-detection Python steps."""

from __future__ import annotations

import os
from typing import Sequence

from PIL import Image

DEFAULT_VISION_MAX_SIDE = 1280


def get_vision_max_side(env: dict[str, str] | None = None) -> int:
    raw = (env or os.environ).get("VISION_MAX_SIDE", str(DEFAULT_VISION_MAX_SIDE))
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_VISION_MAX_SIDE
    return parsed if parsed > 0 else DEFAULT_VISION_MAX_SIDE


def _resample_lanczos() -> int:
    return getattr(Image, "Resampling", Image).LANCZOS


def load_rgb_resized(image_path: str, max_side: int | None = None) -> tuple[Image.Image, int, int]:
    """Load RGB image, downscale if needed. Returns (image, orig_w, orig_h)."""
    resolved_max_side = max_side if max_side is not None else get_vision_max_side()
    if resolved_max_side <= 0:
        raise ValueError(f"max_side must be > 0, got {resolved_max_side}")

    with Image.open(image_path) as opened:
        image = opened.convert("RGB")
        orig_w, orig_h = image.size

    if max(orig_w, orig_h) <= resolved_max_side:
        return image, orig_w, orig_h

    resized = image.copy()
    resized.thumbnail((resolved_max_side, resolved_max_side), _resample_lanczos())
    return resized, orig_w, orig_h


def scale_bbox_to_original(
    bbox: Sequence[float] | None,
    resized_w: int,
    resized_h: int,
    orig_w: int,
    orig_h: int,
) -> list[float] | None:
    """Map bbox from resized inference space back to original pixel coordinates."""
    if bbox is None or len(bbox) != 4:
        return None

    if resized_w <= 0 or resized_h <= 0 or orig_w <= 0 or orig_h <= 0:
        return list(bbox)

    if resized_w == orig_w and resized_h == orig_h:
        return [float(value) for value in bbox]

    scale_x = orig_w / resized_w
    scale_y = orig_h / resized_h
    a, b, c, d = (float(value) for value in bbox)

    if c > a and d > b:
        return [a * scale_x, b * scale_y, c * scale_x, d * scale_y]

    return [a * scale_x, b * scale_y, c * scale_x, d * scale_y]


def format_metal_oom_error(exc: BaseException, image_path: str, max_side: int) -> str:
    message = str(exc)
    if "metal::malloc" in message or "maximum allowed buffer size" in message:
        return (
            f"Vision GPU OOM on {image_path} (max_side={max_side}). "
            "Zmniejsz VISION_MAX_SIDE (np. 1024) lub użyj --vision-stub."
        )
    return message
