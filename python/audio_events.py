#!/usr/bin/env python3
"""Audio event tagging — AudioSet classes via PANNs CNN14 Sound Event Detection."""

import json
import sys
from pathlib import Path

# Minimum class score to consider an event active.
SCORE_THRESHOLD = 0.22
# Merge frames closer than this into one segment.
MIN_SEGMENT_SEC = 0.18
MAX_EVENTS_PER_CLIP = 48
# Long clips: chunk PANNs inference to cap peak RAM (14+ min iPhone clips).
PANNS_CHUNK_SEC = 90.0
PANNS_CHUNK_OVERLAP_SEC = 1.0

_SED_MODEL = None


def _get_sed_model():
    global _SED_MODEL
    if _SED_MODEL is None:
        import contextlib
        import sys
        from panns_inference import SoundEventDetection

        with contextlib.redirect_stdout(sys.stderr):
            _SED_MODEL = SoundEventDetection(checkpoint_path=None, device="cpu")
    return _SED_MODEL


def stub_events(duration_sec: float) -> dict:
    events = [
        {"startSec": 1.2, "endSec": 2.0, "label": "Speech", "score": 0.88},
        {"startSec": 8.5, "endSec": 9.1, "label": "Laughter", "score": 0.74},
        {"startSec": 22.0, "endSec": 22.4, "label": "Squeak", "score": 0.61},
    ]
    events = [e for e in events if e["startSec"] < duration_sec]
    return {
        "audioEvents": events,
        "eventDetectionMode": "stub",
    }


def _frame_duration_sec(sr: int, hop_size: int) -> float:
    return hop_size / float(sr)


def _segments_from_framewise(
    framewise_output,
    labels: list[str],
    frame_sec: float,
    duration_sec: float,
) -> list[dict]:
    import numpy as np

    events: list[dict] = []
    num_frames, num_classes = framewise_output.shape

    for class_idx, label in enumerate(labels):
        scores = framewise_output[:, class_idx]
        active = scores >= SCORE_THRESHOLD
        if not np.any(active):
            continue

        start_frame = None
        peak_score = 0.0
        for frame_idx, is_active in enumerate(active):
            score = float(scores[frame_idx])
            if is_active:
                if start_frame is None:
                    start_frame = frame_idx
                peak_score = max(peak_score, score)
            elif start_frame is not None:
                start_sec = start_frame * frame_sec
                end_sec = min(duration_sec, frame_idx * frame_sec)
                if end_sec - start_sec >= MIN_SEGMENT_SEC:
                    events.append({
                        "startSec": round(start_sec, 3),
                        "endSec": round(end_sec, 3),
                        "label": label,
                        "score": round(peak_score, 3),
                    })
                start_frame = None
                peak_score = 0.0

        if start_frame is not None:
            start_sec = start_frame * frame_sec
            end_sec = min(duration_sec, num_frames * frame_sec)
            if end_sec - start_sec >= MIN_SEGMENT_SEC:
                events.append({
                    "startSec": round(start_sec, 3),
                    "endSec": round(end_sec, 3),
                    "label": label,
                    "score": round(peak_score, 3),
                })

    events.sort(key=lambda e: (-e["score"], e["startSec"]))
    return events[:MAX_EVENTS_PER_CLIP]


def _panns_events_for_audio(audio, sr: int, duration_sec: float, time_offset_sec: float = 0.0) -> list[dict]:
    import numpy as np

    if audio.ndim == 1:
        audio = audio[None, :]

    sed = _get_sed_model()
    framewise = sed.inference(audio)
    if isinstance(framewise, (list, tuple)):
        framewise = framewise[0]
    framewise = np.asarray(framewise)
    if framewise.ndim == 3:
        framewise = framewise[0]

    from panns_inference import labels

    frame_sec = _frame_duration_sec(sr, 320)
    segment_duration = len(audio) / float(sr) if sr else duration_sec
    events = _segments_from_framewise(framewise, labels, frame_sec, segment_duration)
    if time_offset_sec <= 0:
        return events

    for event in events:
        event["startSec"] = round(event["startSec"] + time_offset_sec, 3)
        event["endSec"] = round(event["endSec"] + time_offset_sec, 3)
    return events


def analyze_with_panns(audio_path: str, duration_sec: float) -> dict:
    import librosa

    sr = 32000
    audio, _sr = librosa.load(audio_path, sr=sr, mono=True)
    if audio.size == 0:
        return stub_events(duration_sec)

    effective_duration = duration_sec or len(audio) / float(sr)
    chunk_samples = int(PANNS_CHUNK_SEC * sr)
    overlap_samples = int(PANNS_CHUNK_OVERLAP_SEC * sr)
    step_samples = max(1, chunk_samples - overlap_samples)

    if len(audio) <= chunk_samples:
        events = _panns_events_for_audio(audio, sr, effective_duration)
    else:
        events = []
        for start in range(0, len(audio), step_samples):
            segment = audio[start : start + chunk_samples]
            if segment.size < sr:
                break
            offset_sec = start / float(sr)
            events.extend(_panns_events_for_audio(segment, sr, len(segment) / float(sr), offset_sec))
            if start + chunk_samples >= len(audio):
                break
        events.sort(key=lambda e: (-e["score"], e["startSec"]))
        events = events[:MAX_EVENTS_PER_CLIP]

    return {
        "audioEvents": events,
        "eventDetectionMode": "panns",
    }


def detect_audio_events(payload: dict) -> dict:
    audio_path = payload.get("audioPath")
    duration_sec = float(payload.get("durationSec") or 0)
    stub = bool(payload.get("stub"))

    if stub or not audio_path or not Path(audio_path).exists():
        return stub_events(duration_sec or 60.0)

    try:
        return analyze_with_panns(audio_path, duration_sec)
    except ImportError:
        pass
    except Exception:
        pass

    return {
        "audioEvents": [],
        "eventDetectionMode": "none",
    }


def main() -> None:
    payload = json.load(sys.stdin)
    result = detect_audio_events(payload)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
