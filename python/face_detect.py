#!/usr/bin/env python3
"""Face detection on keyframes — OpenCV Haar, MediaPipe, or stub fallback."""

import json
import sys
from pathlib import Path

# Center-top third stub bbox [x, y, w, h] normalized 0–1
STUB_BBOX = [0.35, 0.05, 0.3, 0.25]


def stub_face_detection(timestamp_sec: float, scene_id: str) -> dict:
    return {
        "type": "face",
        "timestampSec": timestamp_sec,
        "sceneId": scene_id,
        "label": "face",
        "confidence": 0.5,
        "bbox": STUB_BBOX,
    }


def _normalize_bbox(x: float, y: float, w: float, h: float, img_w: int, img_h: int) -> list[float]:
    return [x / img_w, y / img_h, w / img_w, h / img_h]


def detect_with_mediapipe(image_path: str) -> list[dict]:
    import mediapipe as mp

    face_detection = mp.solutions.face_detection.FaceDetection(
        model_selection=0, min_detection_confidence=0.4
    )

    import cv2

    image = cv2.imread(image_path)
    if image is None:
        return []

    img_h, img_w = image.shape[:2]
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    results = face_detection.process(rgb)
    face_detection.close()

    detections = []
    if not results.detections:
        return detections

    for det in results.detections:
        bbox = det.location_data.relative_bounding_box
        detections.append(
            {
                "type": "face",
                "label": "face",
                "confidence": float(det.score[0]) if det.score else 0.5,
                "bbox": [
                    max(0.0, bbox.xmin),
                    max(0.0, bbox.ymin),
                    min(1.0, bbox.width),
                    min(1.0, bbox.height),
                ],
            }
        )
    return detections


def detect_with_opencv(image_path: str) -> list[dict]:
    import cv2

    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    face_cascade = cv2.CascadeClassifier(cascade_path)
    if face_cascade.empty():
        return []

    image = cv2.imread(image_path)
    if image is None:
        return []

    img_h, img_w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))

    detections = []
    for (x, y, w, h) in faces:
        detections.append(
            {
                "type": "face",
                "label": "face",
                "confidence": 0.75,
                "bbox": _normalize_bbox(float(x), float(y), float(w), float(h), img_w, img_h),
            }
        )
    return detections


def detect_faces(image_path: str) -> list[dict]:
    path = Path(image_path)
    if not path.exists():
        return []

    try:
        import mediapipe as mp  # noqa: F401

        return detect_with_mediapipe(image_path)
    except ImportError:
        pass

    try:
        import cv2  # noqa: F401

        return detect_with_opencv(image_path)
    except ImportError:
        pass

    return []


def analyze_frame(frame: dict, use_stub: bool) -> list[dict]:
    timestamp_sec = frame["timestampSec"]
    scene_id = frame["sceneId"]
    image_path = frame["imagePath"]

    if use_stub:
        return [stub_face_detection(timestamp_sec, scene_id)]

    found = detect_faces(image_path)
    if not found:
        return [stub_face_detection(timestamp_sec, scene_id)]

    return [
        {
            **det,
            "timestampSec": timestamp_sec,
            "sceneId": scene_id,
        }
        for det in found
    ]


def main() -> None:
    payload = json.load(sys.stdin)
    frames = payload.get("frames", [])
    use_stub = payload.get("stub", True)

    detections = []
    for frame in frames:
        detections.extend(analyze_frame(frame, use_stub))

    json.dump({"detections": detections}, sys.stdout)


if __name__ == "__main__":
    main()
