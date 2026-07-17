#!/usr/bin/env python3
"""Vocal delivery / engagement analysis — F0, loudness dynamics, pacing."""

import json
import math
import sys
from pathlib import Path
from typing import List, Optional

ASSESSMENT_VERSION = "1.0"
WINDOW_SEC = 5.0
MIN_WINDOW_SEC = 3.0
FLAT_F0_SD_ST = 0.55
FLAT_LOUDNESS_MOD = 0.08
STEADY_WPM_CV = 0.12
MIN_VOICED_RATIO = 0.15

FILLER_WORDS = {
    "um", "uh", "erm", "ah", "like", "you know", "sort of", "kind of",
    "yyy", "eee", "hmm", "mhm",
}


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _hz_to_semitones(f0_hz: float, reference_hz: float = 150.0) -> float:
    if f0_hz <= 0 or reference_hz <= 0:
        return 0.0
    return 12.0 * math.log2(f0_hz / reference_hz)


def stub_delivery(duration_sec: float) -> dict:
    windows = []
    t = 0.0
    while t < duration_sec:
        end = min(duration_sec, t + WINDOW_SEC)
        if end - t < MIN_WINDOW_SEC and windows:
            break
        score = 0.45 + 0.15 * math.sin(t / 7.0)
        windows.append({
            "startSec": round(t, 3),
            "endSec": round(end, 3),
            "f0SemitoneSd": round(0.8 + 0.3 * math.sin(t / 5.0), 3),
            "loudnessModulation": round(0.15 + 0.05 * math.cos(t / 4.0), 3),
            "wpm": 130,
            "pauseRatio": 0.1,
            "voicedRatio": 0.6,
            "engagementScore": round(score, 3),
            "issues": [] if score >= 0.5 else ["flat_pitch"],
        })
        t = end

    clip_score = (
        sum(w["engagementScore"] for w in windows) / len(windows)
        if windows else 0.5
    )
    return {
        "assessmentVersion": ASSESSMENT_VERSION,
        "mode": "stub",
        "windows": windows,
        "clipSummary": _build_clip_summary(windows, clip_score),
    }


def _build_clip_summary(windows: list, clip_score: float) -> dict:
    issue_counts: dict[str, int] = {}
    for window in windows:
        for issue in window.get("issues") or []:
            issue_counts[issue] = issue_counts.get(issue, 0) + 1

    dominant = sorted(issue_counts.items(), key=lambda item: -item[1])
    dominant_issues = [name for name, _ in dominant[:3]]

    if clip_score >= 0.62:
        grade = "engaging"
    elif clip_score >= 0.45:
        grade = "neutral"
    else:
        grade = "flat"

    flat_windows = [
        {
            "startSec": w["startSec"],
            "endSec": w["endSec"],
            "engagementScore": w["engagementScore"],
            "issues": w.get("issues") or [],
        }
        for w in windows
        if w.get("engagementScore", 1) < 0.45
    ]

    return {
        "engagementGrade": grade,
        "engagementScore": round(clip_score, 3),
        "dominantIssues": dominant_issues,
        "flatWindowCount": len(flat_windows),
        "flatDeliveryWindows": flat_windows[:12],
    }


def _extract_f0_contour(y, sr):
    import numpy as np

    try:
        import parselmouth
    except ImportError as exc:
        raise RuntimeError(
            "parselmouth is required for delivery_analysis "
            "(pip3 install -r python/requirements.txt)"
        ) from exc

    try:
        sound = parselmouth.Sound(y, sampling_frequency=sr)
        pitch = sound.to_pitch(time_step=0.01, pitch_floor=75, pitch_ceiling=500)
        times = pitch.xs()
        values = [pitch.get_value_at_time(t) for t in times]
        f0 = np.array([v if v and not math.isnan(v) else 0.0 for v in values], dtype=float)
        return f0, times, "parselmouth"
    except Exception:
        # Per-clip fallback when Praat cannot track pitch on a specific take.
        import librosa
        f0, _, _ = librosa.pyin(
            y,
            fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C6"),
            sr=sr,
            fill_na=0.0,
        )
        return f0, None, "librosa_pyin"


def _window_f0_stats(f0, sr, start_sec: float, end_sec: float, frame_times=None):
    import numpy as np

    if f0 is None or len(f0) == 0:
        return None, 0.0

    if frame_times is not None:
        mask = (frame_times >= start_sec) & (frame_times < end_sec)
        segment = f0[mask]
    else:
        hop = max(256, sr // 100)
        start_idx = int(start_sec * sr / hop)
        end_idx = int(end_sec * sr / hop)
        segment = f0[start_idx:end_idx]

    voiced = segment[(segment > 50) & np.isfinite(segment)]
    if voiced.size < 3:
        return None, float(voiced.size / max(1, segment.size))

    ref = float(np.median(voiced))
    semitones = np.array([_hz_to_semitones(v, ref) for v in voiced])
    sd = float(np.std(semitones))
    return round(sd, 3), float(voiced.size / max(1, segment.size))


def _window_loudness_modulation(y, sr, start_sec: float, end_sec: float) -> float:
    import numpy as np

    start = int(start_sec * sr)
    end = int(end_sec * sr)
    segment = y[start:end]
    if segment.size < sr // 4:
        return 0.0

    hop = max(256, sr // 50)
    frame_len = hop * 2
    rms_values = []
    for offset in range(0, len(segment) - frame_len, hop):
        frame = segment[offset : offset + frame_len]
        rms = float(np.sqrt(np.mean(frame ** 2)))
        if rms > 1e-10:
            rms_values.append(20.0 * math.log10(rms))

    if len(rms_values) < 2:
        return 0.0
    return round((max(rms_values) - min(rms_values)) / 40.0, 3)


def _words_in_window(words: list, start_sec: float, end_sec: float) -> list:
    return [
        w for w in words
        if w.get("end", 0) > start_sec and w.get("start", 0) < end_sec
    ]


def _pace_stats(words: list, start_sec: float, end_sec: float) -> tuple:
    window_words = _words_in_window(words, start_sec, end_sec)
    if len(window_words) < 2:
        return None, None, 0.0

    spoken = [w for w in window_words if not w.get("isFiller")]
    duration_min = max((end_sec - start_sec) / 60.0, 1 / 60.0)
    wpm = len(spoken) / duration_min if spoken else None

    gaps = []
    sorted_words = sorted(window_words, key=lambda w: w.get("start", 0))
    for i in range(1, len(sorted_words)):
        gap = sorted_words[i]["start"] - sorted_words[i - 1]["end"]
        if gap > 0.05:
            gaps.append(gap)

    pause_ratio = sum(gaps) / max(end_sec - start_sec, 0.001) if gaps else 0.0
    return wpm, pause_ratio, len(spoken)


def _filler_density(words: list, start_sec: float, end_sec: float) -> float:
    window_words = _words_in_window(words, start_sec, end_sec)
    if not window_words:
        return 0.0
    fillers = sum(
        1 for w in window_words
        if w.get("isFiller") or (w.get("word") or "").lower().strip() in FILLER_WORDS
    )
    return fillers / len(window_words)


def _score_window(f0_sd, loudness_mod, wpm, pause_ratio, voiced_ratio, filler_density) -> tuple:
    issues = []

    f0_component = _clamp((f0_sd or 0) / 2.5) if f0_sd is not None else 0.5
    loud_component = _clamp((loudness_mod or 0) / 0.35)
    pace_component = 0.5
    if wpm is not None:
        pace_component = _clamp(abs(wpm - 145) / 80, 0, 1) * 0.5 + _clamp(pause_ratio / 0.25) * 0.5

    if f0_sd is not None and f0_sd < FLAT_F0_SD_ST:
        issues.append("flat_pitch")
    if loudness_mod is not None and loudness_mod < FLAT_LOUDNESS_MOD:
        issues.append("steady_energy")
    if wpm is not None and pause_ratio < 0.03 and 120 <= wpm <= 160:
        issues.append("steady_pace")
    if filler_density > 0.2:
        issues.append("high_fillers")

    if voiced_ratio < MIN_VOICED_RATIO:
        engagement = 0.5
    else:
        engagement = round(
            0.40 * f0_component
            + 0.30 * loud_component
            + 0.20 * pace_component
            + 0.10 * (1 - filler_density),
            3,
        )

    return engagement, issues


def analyze_delivery(
    audio_path,
    *,
    duration_sec: float = 0.0,
    words: Optional[List] = None,
    stub: bool = False,
) -> dict:
    if stub or not audio_path or not Path(audio_path).exists():
        return stub_delivery(duration_sec or 60.0)

    try:
        import librosa
        import numpy as np
    except ImportError:
        return {
            "assessmentVersion": ASSESSMENT_VERSION,
            "mode": "stub",
            "windows": [],
            "clipSummary": {
                "engagementGrade": "neutral",
                "engagementScore": 0.5,
                "dominantIssues": ["librosa_unavailable"],
                "flatWindowCount": 0,
                "flatDeliveryWindows": [],
            },
        }

    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    if y.size == 0:
        return stub_delivery(duration_sec or 60.0)

    clip_duration = duration_sec or float(len(y) / sr)
    f0, frame_times, f0_mode = _extract_f0_contour(y, sr)
    word_list = words or []

    windows = []
    t = 0.0
    while t < clip_duration:
        end = min(clip_duration, t + WINDOW_SEC)
        if end - t < MIN_WINDOW_SEC:
            break

        f0_sd, voiced_ratio = _window_f0_stats(f0, sr, t, end, frame_times)
        loudness_mod = _window_loudness_modulation(y, sr, t, end)
        wpm, pause_ratio, _ = _pace_stats(word_list, t, end) if word_list else (None, None, 0)
        filler_density = _filler_density(word_list, t, end) if word_list else 0.0

        engagement, issues = _score_window(
            f0_sd, loudness_mod, wpm, pause_ratio or 0.0, voiced_ratio, filler_density,
        )

        window = {
            "startSec": round(t, 3),
            "endSec": round(end, 3),
            "engagementScore": engagement,
            "issues": issues,
            "voicedRatio": round(voiced_ratio, 3),
        }
        if f0_sd is not None:
            window["f0SemitoneSd"] = f0_sd
        if loudness_mod is not None:
            window["loudnessModulation"] = loudness_mod
        if wpm is not None:
            window["wpm"] = round(wpm, 1)
            window["pauseRatio"] = round(pause_ratio or 0.0, 3)

        windows.append(window)
        t = end

    clip_score = (
        sum(w["engagementScore"] for w in windows) / len(windows)
        if windows else 0.5
    )

    mode = "hybrid" if word_list else "heuristic"
    if f0_mode == "parselmouth":
        mode = "hybrid" if word_list else "heuristic"

    return {
        "assessmentVersion": ASSESSMENT_VERSION,
        "mode": mode if f0_mode != "none" else "stub",
        "windows": windows,
        "clipSummary": _build_clip_summary(windows, clip_score),
    }


def main() -> None:
    payload = json.load(sys.stdin)
    words = payload.get("words")
    if isinstance(words, list):
        normalized = []
        for entry in words:
            normalized.append({
                "word": entry.get("word", ""),
                "start": float(entry.get("start", 0)),
                "end": float(entry.get("end", entry.get("start", 0) + 0.1)),
                "isFiller": bool(entry.get("isFiller")),
            })
        words = normalized
    else:
        words = None

    result = analyze_delivery(
        payload.get("audioPath"),
        duration_sec=float(payload.get("durationSec") or 0),
        words=words,
        stub=bool(payload.get("stub")),
    )
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
