#!/usr/bin/env python3
"""Vision analysis with Qwen2.5-VL via mlx-vlm when available, else stub captions."""

import json
import sys
import tempfile
from pathlib import Path

from vlm_image_utils import format_metal_oom_error, get_vision_max_side, load_rgb_resized


def stub_caption(image_path: str, timestamp_sec: float, scene_id: str) -> dict:
    name = Path(image_path).name
    return {
        "timestampSec": timestamp_sec,
        "sceneId": scene_id,
        "caption": f"[stub] Klatka {name} — zainstaluj mlx-vlm dla pełnej analizy Qwen2.5-VL.",
        "tags": ["stub"],
    }


def analyze_with_mlx(frames: list[dict], model: str, prompt: str) -> list[dict]:
    from mlx_vlm import generate, load
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import load_config
    from transformers import AutoImageProcessor

    model_obj, processor = load(model)
    # Newer transformers default to a fast image processor that rejects non-pt tensors;
    # mlx-vlm needs the slow path (numpy / mlx arrays).
    try:
        processor.image_processor = AutoImageProcessor.from_pretrained(
            model,
            use_fast=False,
            trust_remote_code=True,
        )
    except Exception:
        pass

    config = load_config(model)
    formatted_prompt = apply_chat_template(
        processor,
        config,
        prompt,
        add_generation_prompt=True,
        num_images=1,
    )
    captions = []
    max_side = get_vision_max_side()

    with tempfile.TemporaryDirectory(prefix="vea-vision-") as temp_dir:
        for index, frame in enumerate(frames):
            image_path = frame["imagePath"]
            try:
                resized_image, _, _ = load_rgb_resized(image_path, max_side=max_side)
                temp_path = Path(temp_dir) / f"frame-{index:04d}.jpg"
                resized_image.save(temp_path, format="JPEG", quality=90)
                text = generate(
                    model_obj,
                    processor,
                    formatted_prompt,
                    str(temp_path),
                    verbose=False,
                    max_tokens=256,
                )
            except RuntimeError as exc:
                raise RuntimeError(format_metal_oom_error(exc, image_path, max_side)) from exc

            captions.append(
                {
                    "timestampSec": frame["timestampSec"],
                    "sceneId": frame["sceneId"],
                    "caption": str(text).strip(),
                    "tags": [],
                }
            )

    return captions


def main() -> None:
    payload = json.load(sys.stdin)
    frames = payload.get("frames", [])
    model = payload.get("model", "mlx-community/Qwen2.5-VL-7B-Instruct-4bit")
    prompt = payload.get(
        "prompt",
        "Opisz po polsku co widać na klatce: osoby, akcje, miejsce, nastrój, istotne obiekty. "
        "Bądź konkretny i zwięzły (2-4 zdania).",
    )
    use_stub = payload.get("stub", False)

    if use_stub or not frames:
        captions = [
            stub_caption(f["imagePath"], f["timestampSec"], f["sceneId"]) for f in frames
        ]
    else:
        try:
            captions = analyze_with_mlx(frames, model, prompt)
        except ImportError:
            captions = [
                stub_caption(f["imagePath"], f["timestampSec"], f["sceneId"]) for f in frames
            ]

    json.dump({"captions": captions}, sys.stdout)


if __name__ == "__main__":
    main()
