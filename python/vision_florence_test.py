#!/usr/bin/env python3
import unittest
from unittest.mock import MagicMock

from vision_florence import FLORENCE_GENERATE_KWARGS, _generate_florence, _iter_od_detections


class VisionFlorenceTest(unittest.TestCase):
    def test_florence_generate_kwargs_disable_cache(self) -> None:
        self.assertFalse(FLORENCE_GENERATE_KWARGS["use_cache"])

    def test_generate_florence_requires_pixel_values(self) -> None:
        model = MagicMock()
        with self.assertRaisesRegex(ValueError, "pixel_values"):
            _generate_florence(model, {"input_ids": MagicMock()})

    def test_generate_florence_passes_use_cache_false(self) -> None:
        model = MagicMock()
        model.generate.return_value = "ok"
        inputs = {"input_ids": "ids", "pixel_values": "pixels"}
        result = _generate_florence(model, inputs)
        self.assertEqual(result, "ok")
        model.generate.assert_called_once_with(
            input_ids="ids",
            pixel_values="pixels",
            **FLORENCE_GENERATE_KWARGS,
        )

    def test_iter_od_detections_supports_parallel_labels(self) -> None:
        parsed = {
            "<OD>": {
                "bboxes": [[1.0, 2.0, 3.0, 4.0]],
                "labels": ["animal"],
            },
        }
        items = _iter_od_detections(parsed)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["bbox"], [1.0, 2.0, 3.0, 4.0])
        self.assertEqual(items[0]["label"], "animal")

    def test_iter_od_detections_supports_legacy_dict_bboxes(self) -> None:
        parsed = {
            "<OD>": {
                "bboxes": [{"bbox": [0.1, 0.2, 0.3, 0.4], "label": "person", "score": 0.9}],
            },
        }
        items = _iter_od_detections(parsed)
        self.assertEqual(items[0]["label"], "person")
        self.assertEqual(items[0]["score"], 0.9)


if __name__ == "__main__":
    unittest.main()
