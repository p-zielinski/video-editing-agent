#!/usr/bin/env python3
"""Vision analysis with Qwen2.5-VL via mlx-vlm when available, else stub captions."""

import json
import sys
from pathlib import Path


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

    for frame in frames:
        text = generate(
            model_obj,
            processor,
            formatted_prompt,
            frame["imagePath"],
            verbose=False,
            max_tokens=256,
        )
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
