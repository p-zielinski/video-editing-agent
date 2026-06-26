#!/usr/bin/env python3
"""Scene detection via ffmpeg scene filter (no extra deps required)."""

import json
import subprocess
import sys


def detect_scenes(video_path: str, threshold: float = 0.3) -> list[dict]:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-i",
        video_path,
        "-filter:v",
        f"select='gt(scene,{threshold})',showinfo",
        "-f",
        "null",
        "-",
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    stderr = result.stderr

    cut_points: list[dict] = [{"pts_time": 0.0, "cut_score": None}]
    for line in stderr.splitlines():
        if "pts_time:" not in line:
            continue

        pts_time = None
        cut_score = None
        for part in line.split():
            if part.startswith("pts_time:"):
                try:
                    pts_time = float(part.split(":")[1])
                except ValueError:
                    pass
            if part.startswith("scene:"):
                try:
                    cut_score = float(part.split(":")[1])
                except ValueError:
                    pass

        if pts_time is not None:
            cut_points.append({"pts_time": pts_time, "cut_score": cut_score})

    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            video_path,
        ],
        capture_output=True,
        text=True,
    )
    duration = float(probe.stdout.strip() or "0")
    if duration <= 0:
        return [{"startSec": 0.0, "endSec": 1.0}]

    unique_points: list[dict] = []
    seen_times: set[float] = set()
    for point in sorted(cut_points, key=lambda entry: entry["pts_time"]):
        rounded = round(point["pts_time"], 3)
        if rounded in seen_times:
            continue
        seen_times.add(rounded)
        unique_points.append({"pts_time": rounded, "cut_score": point["cut_score"]})

    scenes = []
    for i, point in enumerate(unique_points):
        start = point["pts_time"]
        end = unique_points[i + 1]["pts_time"] if i + 1 < len(unique_points) else round(duration, 3)
        if end > start:
            scene = {"startSec": start, "endSec": end}
            if i > 0 and point["cut_score"] is not None:
                scene["cutScore"] = round(point["cut_score"], 4)
            scenes.append(scene)

    if not scenes:
        scenes = [{"startSec": 0.0, "endSec": round(duration, 3)}]

    return scenes


def main() -> None:
    payload = json.load(sys.stdin)
    video_path = payload["videoPath"]
    threshold = float(payload.get("threshold", 0.3))
    scenes = detect_scenes(video_path, threshold)
    json.dump({"scenes": scenes}, sys.stdout)


if __name__ == "__main__":
    main()
