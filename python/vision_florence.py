#!/usr/bin/env python3
"""Florence-2 open-vocabulary detection on keyframes (required pipeline step)."""

import json
import sys

from vlm_image_utils import get_vision_max_side, load_rgb_resized, scale_bbox_to_original

# transformers>=4.50 changed KV cache semantics; Florence-2 remote code crashes with use_cache=True.
FLORENCE_GENERATE_KWARGS = {
    "max_new_tokens": 256,
    "num_beams": 3,
    "use_cache": False,
}


def _generate_florence(model, inputs):
    pixel_values = inputs.get("pixel_values")
    if pixel_values is None:
        raise ValueError("Florence-2 processor returned no pixel_values for image input")
    return model.generate(
        input_ids=inputs["input_ids"],
        pixel_values=pixel_values,
        **FLORENCE_GENERATE_KWARGS,
    )


def _iter_od_detections(parsed: dict, task: str = "<OD>") -> list[dict]:
    od = parsed.get(task, {})
    if not isinstance(od, dict):
        return []

    raw_bboxes = od.get("bboxes", [])
    raw_labels = od.get("labels", [])
    detections: list[dict] = []

    for index, bbox_entry in enumerate(raw_bboxes):
        if isinstance(bbox_entry, dict):
            detections.append({
                "bbox": bbox_entry.get("bbox"),
                "label": bbox_entry.get("label", "object"),
                "score": float(bbox_entry.get("score", 0.5)),
            })
            continue

        label = raw_labels[index] if index < len(raw_labels) else "object"
        detections.append({
            "bbox": bbox_entry,
            "label": label,
            "score": 0.5,
        })

    return detections


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
            "  pip3 install torch torchvision transformers pillow\n"
            "Lub ustaw PYTHON_VENV na venv z tymi pakietami. "
            "Escape hatch: --no-objects (pomija krok detekcji)."
        ) from exc

    from transformers import AutoModelForCausalLM, AutoProcessor

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    try:
        model = AutoModelForCausalLM.from_pretrained(
            model_id,
            trust_remote_code=True,
            attn_implementation="eager",
        ).to(device)
    except TypeError:
        model = AutoModelForCausalLM.from_pretrained(model_id, trust_remote_code=True).to(device)
    # Compat with newer transformers — Florence-2 remote code may omit this flag.
    if not hasattr(model, "_supports_sdpa"):
        model._supports_sdpa = False
    processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)

    detections = []
    task = "<OD>"
    max_side = get_vision_max_side()

    for frame in frames:
        image, orig_w, orig_h = load_rgb_resized(frame["imagePath"], max_side=max_side)
        resized_w, resized_h = image.size
        inputs = processor(text=task, images=image, return_tensors="pt").to(device)
        generated = _generate_florence(model, inputs)
        text = processor.batch_decode(generated, skip_special_tokens=False)[0]
        parsed = processor.post_process_generation(text, task=task, image_size=image.size)

        for item in _iter_od_detections(parsed, task=task):
            bbox = scale_bbox_to_original(
                item.get("bbox"),
                resized_w,
                resized_h,
                orig_w,
                orig_h,
            )
            detections.append(
                {
                    "timestampSec": frame["timestampSec"],
                    "sceneId": frame["sceneId"],
                    "label": item.get("label", "object"),
                    "confidence": float(item.get("score", 0.5)),
                    "bbox": bbox,
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
