#!/usr/bin/env python3
import os
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from vlm_image_utils import (
    DEFAULT_VISION_MAX_SIDE,
    format_metal_oom_error,
    get_vision_max_side,
    load_rgb_resized,
    scale_bbox_to_original,
)


class VlmImageUtilsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._previous_max_side = os.environ.get("VISION_MAX_SIDE")
        os.environ["VISION_MAX_SIDE"] = "1280"

    def tearDown(self) -> None:
        if self._previous_max_side is None:
            os.environ.pop("VISION_MAX_SIDE", None)
        else:
            os.environ["VISION_MAX_SIDE"] = self._previous_max_side

    def test_get_vision_max_side_defaults_to_1280(self) -> None:
        self.assertEqual(get_vision_max_side({}), DEFAULT_VISION_MAX_SIDE)
        self.assertEqual(get_vision_max_side({"VISION_MAX_SIDE": "1024"}), 1024)
        self.assertEqual(get_vision_max_side({"VISION_MAX_SIDE": "bad"}), DEFAULT_VISION_MAX_SIDE)
        self.assertEqual(get_vision_max_side({"VISION_MAX_SIDE": "0"}), DEFAULT_VISION_MAX_SIDE)

    def test_load_rgb_resized_downscales_4k(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "frame.jpg"
            Image.new("RGB", (3840, 2160), color=(10, 20, 30)).save(image_path, format="JPEG")

            resized, orig_w, orig_h = load_rgb_resized(str(image_path), max_side=1280)

            self.assertEqual((orig_w, orig_h), (3840, 2160))
            self.assertLessEqual(max(resized.size), 1280)
            self.assertAlmostEqual(resized.size[0] / resized.size[1], 3840 / 2160, places=2)

    def test_load_rgb_resized_keeps_small_images(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "frame.jpg"
            Image.new("RGB", (1024, 768), color=(40, 50, 60)).save(image_path, format="JPEG")

            resized, orig_w, orig_h = load_rgb_resized(str(image_path), max_side=1280)

            self.assertEqual((orig_w, orig_h), (1024, 768))
            self.assertEqual(resized.size, (1024, 768))

    def test_scale_bbox_to_original_xywh(self) -> None:
        scaled = scale_bbox_to_original([100, 50, 200, 100], 1920, 1080, 3840, 2160)
        self.assertEqual(scaled, [200.0, 100.0, 400.0, 200.0])

    def test_scale_bbox_to_original_xyxy(self) -> None:
        scaled = scale_bbox_to_original([100, 50, 300, 150], 1920, 1080, 3840, 2160)
        self.assertEqual(scaled, [200.0, 100.0, 600.0, 300.0])

    def test_scale_bbox_to_original_noop_when_same_size(self) -> None:
        bbox = [0.1, 0.2, 0.3, 0.4]
        self.assertEqual(scale_bbox_to_original(bbox, 1280, 720, 1280, 720), bbox)

    def test_format_metal_oom_error(self) -> None:
        message = format_metal_oom_error(
            RuntimeError("[metal::malloc] Attempting to allocate 56976077312 bytes"),
            "/tmp/frame.jpg",
            1280,
        )
        self.assertIn("Vision GPU OOM", message)
        self.assertIn("VISION_MAX_SIDE", message)


if __name__ == "__main__":
    unittest.main()
