#!/usr/bin/env python3
"""Florence-2 open-vocabulary detection on keyframes (required pipeline step)."""

import json
import sys
from pathlib import Path


def stub_detection(image_path: str, timestamp_sec: float, scene_id: str) -> list[dict]:
    return [
        {
            "timestampSec": timestamp_sec,
            "sceneId": scene_id,
            "label": "[stub] person",
            "confidence": 0.5,
            "bbox": [0.25, 0.2, 0.5, 0.6],
        }
    ]


def analyze_with_florence(frames: list[dict], model_id: str) -> list[dict]:
    try:
        import torch
    except ImportError as exc:
        raise ImportError(
            "Florence-2 wymaga pakietu torch. Zainstaluj zależności Python:\n"
            "  pip install torch torchvision transformers pillow\n"
            "Lub ustaw PYTHON_VENV na venv z tymi pakietami. "
            "Escape hatch: --no-objects (pomija krok detekcji)."
        ) from exc

    from PIL import Image
    from transformers import AutoProcessor, AutoModelForCausalLM

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = AutoModelForCausalLM.from_pretrained(model_id, trust_remote_code=True).to(device)
    processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)

    detections = []
    task = "<OD>"

    for frame in frames:
        image = Image.open(frame["imagePath"]).convert("RGB")
        inputs = processor(text=task, images=image, return_tensors="pt").to(device)
        generated = model.generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=256,
            num_beams=3,
        )
        text = processor.batch_decode(generated, skip_special_tokens=False)[0]
        parsed = processor.post_process_generation(text, task=task, image_size=image.size)

        for item in parsed.get("<OD>", {}).get("bboxes", []):
            detections.append(
                {
                    "timestampSec": frame["timestampSec"],
                    "sceneId": frame["sceneId"],
                    "label": item.get("label", "object"),
                    "confidence": float(item.get("score", 0.5)),
                    "bbox": item.get("bbox"),
                }
            )

    return detections


def main() -> None:
    payload = json.load(sys.stdin)
    frames = payload.get("frames", [])
    model_id = payload.get("model", "microsoft/Florence-2-base")
    use_stub = payload.get("stub", True)

    if use_stub or not frames:
        detections = []
        for frame in frames:
            detections.extend(
                stub_detection(frame["imagePath"], frame["timestampSec"], frame["sceneId"])
            )
    else:
        try:
            detections = analyze_with_florence(frames, model_id)
        except ImportError:
            raise
        except Exception as exc:
            print(
                f"Florence-2 analysis failed: {exc}. "
                "Sprawdź torch/transformers lub użyj --no-objects.",
                file=sys.stderr,
            )
            sys.exit(1)

    json.dump({"detections": detections}, sys.stdout)


if __name__ == "__main__":
    main()
