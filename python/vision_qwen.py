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
    from mlx_vlm import load
    from mlx_vlm.utils import load_image

    model_obj, processor = load(model)
    captions = []

    for frame in frames:
        image = load_image(frame["imagePath"])
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": prompt},
                ],
            }
        ]
        prompt_text = processor.apply_chat_template(messages, add_generation_prompt=True)
        inputs = processor(text=prompt_text, images=[image], return_tensors="np")
        output = model_obj.generate(**inputs, max_tokens=256)
        text = processor.decode(output[0], skip_special_tokens=True)

        captions.append(
            {
                "timestampSec": frame["timestampSec"],
                "sceneId": frame["sceneId"],
                "caption": text.strip(),
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
