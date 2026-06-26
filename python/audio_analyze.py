#!/usr/bin/env python3
"""Audio analysis — beats, energy curve, silence gaps via librosa or ffmpeg fallback."""

import json
import math
import subprocess
import sys
from pathlib import Path


def stub_analysis(duration_sec: float) -> dict:
    beat_interval = 0.5
    beats = []
    t = beat_interval
    while t < duration_sec:
        beats.append({"timeSec": round(t, 3), "strength": 0.55})
        t += beat_interval

    energy = []
    window = 1.0
    t = 0.0
    while t < duration_sec:
        end = min(duration_sec, t + window)
        rms_db = -22.0 + 4.0 * math.sin(t / 8.0)
        energy.append({"startSec": round(t, 3), "endSec": round(end, 3), "rmsDb": round(rms_db, 2)})
        t += window

    silence_gaps = []
    if duration_sec > 30:
        silence_gaps.append({
            "startSec": round(duration_sec * 0.4, 3),
            "endSec": round(duration_sec * 0.4 + 1.2, 3),
            "durationSec": 1.2,
        })

    cut_suggestions = [
        {"timeSec": beats[0]["timeSec"], "reason": "onset", "strength": 0.7},
    ] if beats else []

    return {
        "energyCurve": energy,
        "silenceGaps": silence_gaps,
        "beats": beats,
        "cutSuggestions": cut_suggestions,
        "estimatedBpm": 120.0,
        "analysisMode": "stub",
    }


def _rms_db(frame):
    import numpy as np

    if frame.size == 0:
        return -60.0
    rms = float(np.sqrt(np.mean(frame ** 2)))
    if rms <= 1e-10:
        return -60.0
    return float(20.0 * math.log10(rms))


def _onset_strength_at_time(onset_env, time_sec, sr, hop_length):
    import librosa

    if len(onset_env) == 0:
        return 0.5
    frame_idx = librosa.time_to_frames(time_sec, sr=sr, hop_length=hop_length)
    strength = float(onset_env[min(frame_idx, len(onset_env) - 1)])
    return min(1.0, max(0.0, strength / 20.0))


def _silence_gaps_from_energy_curve(
    energy_curve: list,
    silence_threshold_db: float = -40.0,
    min_gap_sec: float = 0.35,
) -> list:
    silence_gaps = []
    gap_start = None
    for point in energy_curve:
        if point["rmsDb"] < silence_threshold_db:
            if gap_start is None:
                gap_start = point["startSec"]
        elif gap_start is not None:
            gap_end = point["startSec"]
            if gap_end - gap_start >= min_gap_sec:
                silence_gaps.append({
                    "startSec": round(gap_start, 3),
                    "endSec": round(gap_end, 3),
                    "durationSec": round(gap_end - gap_start, 3),
                })
            gap_start = None
    return silence_gaps


def _cut_suggestions_from_silence_gaps(silence_gaps: list, max_count: int = 8) -> list:
    return [
        {
            "timeSec": gap["startSec"],
            "reason": "silence_start",
            "strength": 0.65,
        }
        for gap in silence_gaps[:max_count]
    ]


def _ffmpeg_astats_result(energy_curve: list) -> dict:
    silence_gaps = _silence_gaps_from_energy_curve(energy_curve)
    return {
        "energyCurve": energy_curve,
        "silenceGaps": silence_gaps,
        "beats": [],
        "cutSuggestions": _cut_suggestions_from_silence_gaps(silence_gaps),
        "estimatedBpm": None,
        "analysisMode": "ffmpeg_astats",
    }


def _is_likely_speech(y, sr, hop_length, duration_sec, tempo, beat_frames):
    """Heuristic: voice audio triggers false beats from librosa beat_track."""
    import librosa
    import numpy as np

    beat_count = len(beat_frames)
    if tempo > 180 or beat_count > duration_sec * 2:
        return True

    zcr = librosa.feature.zero_crossing_rate(y, hop_length=hop_length)[0]
    if float(np.std(zcr)) > 0.08 and float(np.mean(zcr)) > 0.05:
        return True

    return False


def analyze_with_librosa(audio_path: str, duration_sec: float) -> dict:
    import librosa
    import numpy as np

    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    if y.size == 0:
        return stub_analysis(duration_sec)

    hop_length = 512
    frame_length = 2048
    rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)

    energy_curve = []
    bucket_sec = 1.0
    bucket_start = 0.0
    bucket_rms = []
    for idx, t in enumerate(times):
        if t - bucket_start >= bucket_sec and bucket_rms:
            energy_curve.append({
                "startSec": round(bucket_start, 3),
                "endSec": round(min(duration_sec, t), 3),
                "rmsDb": round(float(np.mean(bucket_rms)), 2),
            })
            bucket_start = t
            bucket_rms = []
        bucket_rms.append(_rms_db(np.array([rms[idx]])))
    if bucket_rms:
        energy_curve.append({
            "startSec": round(bucket_start, 3),
            "endSec": round(duration_sec, 3),
            "rmsDb": round(float(np.mean(bucket_rms)), 2),
        })

    silence_gaps = _silence_gaps_from_energy_curve(energy_curve)

    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop_length)
    speech_mode = _is_likely_speech(y, sr, hop_length, duration_sec, float(tempo), beat_frames)

    if speech_mode:
        onset_frames = librosa.onset.onset_detect(
            onset_envelope=onset_env,
            sr=sr,
            hop_length=hop_length,
            backtrack=False,
        )
        marker_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop_length)
        analysis_mode = "speech_onsets"
        cut_reason = "onset"
        estimated_bpm = None
    else:
        marker_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)
        analysis_mode = "musical_beats"
        cut_reason = "beat"
        estimated_bpm = float(tempo) if np.isfinite(tempo) else None

    beats = []
    for marker_time in marker_times:
        norm_strength = _onset_strength_at_time(onset_env, float(marker_time), sr, hop_length)
        beats.append({
            "timeSec": round(float(marker_time), 3),
            "strength": round(norm_strength, 3),
        })

    cut_suggestions = []
    for beat in beats[: min(12, len(beats))]:
        cut_suggestions.append({
            "timeSec": beat["timeSec"],
            "reason": cut_reason,
            "strength": beat["strength"],
        })
    for gap in silence_gaps[:5]:
        cut_suggestions.append({
            "timeSec": gap["startSec"],
            "reason": "silence_start",
            "strength": 0.65,
        })

    return {
        "energyCurve": energy_curve,
        "silenceGaps": silence_gaps,
        "beats": beats,
        "cutSuggestions": cut_suggestions,
        "estimatedBpm": round(estimated_bpm, 1) if estimated_bpm else None,
        "analysisMode": analysis_mode,
    }


def analyze_with_ffmpeg(audio_path: str, duration_sec: float) -> dict:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-i",
        audio_path,
        "-af",
        "astats=metadata=1:reset=1,ametadata=print:file=-",
        "-f",
        "null",
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return _ffmpeg_astats_result([])

    stderr = proc.stderr or ""
    rms_values = []
    for line in stderr.splitlines():
        if "RMS level dB" in line:
            try:
                value = float(line.split(":")[-1].strip())
                rms_values.append(value)
            except ValueError:
                continue

    energy_curve = []
    if rms_values:
        window = max(1, len(rms_values) // max(1, int(duration_sec)))
        for i in range(0, len(rms_values), window):
            chunk = rms_values[i : i + window]
            start = duration_sec * (i / len(rms_values))
            end = duration_sec * (min(i + window, len(rms_values)) / len(rms_values))
            energy_curve.append({
                "startSec": round(start, 3),
                "endSec": round(end, 3),
                "rmsDb": round(sum(chunk) / len(chunk), 2),
            })

    return _ffmpeg_astats_result(energy_curve)


def analyze_audio(payload: dict) -> dict:
    audio_path = payload.get("audioPath")
    duration_sec = float(payload.get("durationSec") or 0)
    stub = bool(payload.get("stub"))

    if stub or not audio_path or not Path(audio_path).exists():
        return stub_analysis(duration_sec or 60.0)

    try:
        import librosa  # noqa: F401

        return analyze_with_librosa(audio_path, duration_sec)
    except ImportError:
        return analyze_with_ffmpeg(audio_path, duration_sec)
    except Exception:
        return analyze_with_ffmpeg(audio_path, duration_sec)


def main() -> None:
    payload = json.load(sys.stdin)
    result = analyze_audio(payload)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
