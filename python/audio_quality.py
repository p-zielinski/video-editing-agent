#!/usr/bin/env python3
"""Heuristic audio quality assessment — SNR, clipping, wind, hum."""

import json
import math
import sys
from pathlib import Path


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _rms_db(samples) -> float:
    import numpy as np

    if samples.size == 0:
        return -60.0
    rms = float(np.sqrt(np.mean(samples ** 2)))
    if rms <= 1e-10:
        return -60.0
    return float(20.0 * math.log10(rms))


def _percentile(values, pct: float):
    import numpy as np

    if not values:
        return None
    return float(np.percentile(values, pct))


def _heuristic_wind_score(y, sr) -> float:
    import numpy as np

    if y.size < sr // 4:
        return 0.0

    hop = max(256, sr // 50)
    frame_len = hop * 2
    low_energy = []
    envelope_var = []

    for start in range(0, len(y) - frame_len, hop):
        frame = y[start : start + frame_len]
        spectrum = np.abs(np.fft.rfft(frame))
        freqs = np.fft.rfftfreq(frame_len, 1.0 / sr)
        low_band = spectrum[freqs < 200.0]
        low_energy.append(float(np.mean(low_band)) if low_band.size else 0.0)
        envelope_var.append(float(np.std(np.abs(frame))))

    if not low_energy:
        return 0.0

    low_norm = np.array(low_energy) / (np.max(low_energy) + 1e-10)
    env_norm = np.array(envelope_var) / (np.max(envelope_var) + 1e-10)
    return _clamp(float(np.mean(low_norm) * 0.6 + np.mean(env_norm) * 0.4))


def _hum_score(y, sr) -> float:
    import numpy as np

    if y.size < sr:
        return 0.0

    spectrum = np.abs(np.fft.rfft(y))
    freqs = np.fft.rfftfreq(len(y), 1.0 / sr)
    total = float(np.sum(spectrum)) + 1e-10
    hum_energy = 0.0
    for base in (50.0, 60.0):
        for harmonic in range(1, 6):
            target = base * harmonic
            if target >= sr / 2:
                break
            band = spectrum[(freqs >= target - 2.0) & (freqs <= target + 2.0)]
            hum_energy += float(np.sum(band)) if band.size else 0.0
    return _clamp(hum_energy / total * 8.0)


def _speech_presence_ratio(y, sr, speech_threshold_db: float = -35.0) -> tuple:
    hop = max(256, sr // 50)
    frame_len = hop * 2
    speech_rms = []
    noise_rms = []

    for start in range(0, len(y) - frame_len, hop):
        frame = y[start : start + frame_len]
        db = _rms_db(frame)
        if db >= speech_threshold_db:
            speech_rms.append(db)
        else:
            noise_rms.append(db)

    total_frames = len(speech_rms) + len(noise_rms)
    ratio = len(speech_rms) / total_frames if total_frames else 0.0
    return ratio, speech_rms, noise_rms


def assess_audio_quality(
    audio_path,
    *,
    duration_sec: float = 0.0,
    voice_lufs=None,
    stub: bool = False,
) -> dict:
    """Return audioQuality block for ClipAudioAnalysis."""
    if stub or not audio_path or not Path(audio_path).exists():
        return {
            "assessmentVersion": "1.0",
            "mode": "stub",
            "hasSpeech": False,
            "speechPresenceRatio": 0.0,
            "estimatedSnrDb": None,
            "noiseFloorDbfs": None,
            "clippingRatio": 0.0,
            "windScore": 0.0,
            "humScore": 0.0,
            "speechClarityScore": None,
            "qualityScore": 0.55,
            "grade": "usable",
            "issues": [],
            "confidence": 0.3,
            "enhancementRecommended": False,
            "reasons": ["stub_mode"],
        }

    try:
        import librosa
        import numpy as np
    except ImportError:
        return {
            "assessmentVersion": "1.0",
            "mode": "heuristic",
            "hasSpeech": False,
            "speechPresenceRatio": 0.0,
            "estimatedSnrDb": None,
            "noiseFloorDbfs": None,
            "clippingRatio": 0.0,
            "windScore": 0.0,
            "humScore": 0.0,
            "speechClarityScore": None,
            "qualityScore": 0.5,
            "grade": "usable",
            "issues": [],
            "confidence": 0.2,
            "enhancementRecommended": False,
            "reasons": ["librosa_unavailable"],
        }

    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    if y.size == 0:
        return assess_audio_quality(None, duration_sec=duration_sec, stub=True)

    speech_ratio, speech_rms, noise_rms = _speech_presence_ratio(y, sr)
    has_speech = speech_ratio >= 0.08

    clipping_ratio = float(np.mean(np.abs(y) >= 0.999))
    noise_floor = _percentile(noise_rms, 20) if noise_rms else -50.0
    speech_level = _percentile(speech_rms, 50) if speech_rms else None
    estimated_snr = None
    if speech_level is not None and noise_floor is not None:
        estimated_snr = round(speech_level - noise_floor, 2)

    wind_score = round(_heuristic_wind_score(y, sr), 3)
    hum_score = round(_hum_score(y, sr), 3)

    snr_score = _clamp(((estimated_snr or 0) - 3) / 22) if estimated_snr is not None else 0.5
    level_ref = voice_lufs if voice_lufs is not None else (speech_level or -24)
    level_score = _clamp(1 - abs(level_ref + 18) / 18)
    clipping_score = 1 - _clamp(clipping_ratio / 0.01)
    noise_score = 1 - max(wind_score, hum_score)

    quality_score = round(
        0.45 * snr_score
        + 0.20 * level_score
        + 0.15 * clipping_score
        + 0.20 * noise_score,
        3,
    )

    issues = []
    if estimated_snr is not None and estimated_snr < 12:
        issues.append("low_snr")
    if wind_score >= 0.45:
        issues.append("wind")
    if hum_score >= 0.5:
        issues.append("hum")
    if clipping_ratio > 0.01:
        issues.append("clipping")
    if level_ref < -30:
        issues.append("low_level")
    if speech_ratio < 0.08:
        issues.append("no_speech")
    elif estimated_snr is not None and estimated_snr < 18:
        issues.append("broadband_noise")

    if clipping_ratio > 0.05 or (estimated_snr is not None and estimated_snr < 3):
        grade = "unusable"
    elif quality_score >= 0.75 and (estimated_snr is None or estimated_snr >= 18):
        grade = "good"
    elif quality_score >= 0.55 and (estimated_snr is None or estimated_snr >= 12):
        grade = "usable"
    elif quality_score >= 0.30:
        grade = "poor"
    else:
        grade = "unusable"

    reasons = []
    enhancement_recommended = False
    if has_speech:
        if quality_score < 0.65:
            enhancement_recommended = True
            reasons.append("quality_below_threshold")
        if estimated_snr is not None and estimated_snr < 12:
            enhancement_recommended = True
            reasons.append("low_snr")
        if wind_score >= 0.45:
            enhancement_recommended = True
            reasons.append("wind_detected")
        if voice_lufs is not None and voice_lufs < -30:
            enhancement_recommended = True
            reasons.append("low_level")

    return {
        "assessmentVersion": "1.0",
        "mode": "heuristic",
        "hasSpeech": has_speech,
        "speechPresenceRatio": round(speech_ratio, 3),
        "estimatedSnrDb": estimated_snr,
        "noiseFloorDbfs": round(noise_floor, 2) if noise_floor is not None else None,
        "clippingRatio": round(clipping_ratio, 5),
        "windScore": wind_score,
        "humScore": hum_score,
        "speechClarityScore": None,
        "qualityScore": quality_score,
        "grade": grade,
        "issues": issues,
        "confidence": 0.75 if has_speech else 0.4,
        "enhancementRecommended": enhancement_recommended,
        "reasons": reasons,
    }


def main() -> None:
    payload = json.load(sys.stdin)
    result = assess_audio_quality(
        payload.get("audioPath"),
        duration_sec=float(payload.get("durationSec") or 0),
        voice_lufs=payload.get("voiceLufs"),
        stub=bool(payload.get("stub")),
    )
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
