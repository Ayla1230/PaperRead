"""翻译速度三档、图内文字的小图位置、后端 TeX 检查跟阅读页一样先修补 \\text{…_…}。"""
import unittest
from unittest import mock

from easyread import checks, figure_text, openai_api, segments, translate


class SpeedTest(unittest.TestCase):
    def test_fastest_asks_api_for_low_reasoning_and_keeps_user_choice(self):
        cfg = {"engine": "openai", "speed": "fastest", "openai": {"base_url": "http://x/v1", "model": "m"}}
        out, speed = translate.with_speed(cfg)
        self.assertEqual((speed, out["openai"]["reasoning_effort"]), ("fastest", "low"))
        self.assertEqual(translate.with_speed({**cfg, "openai": {"reasoning_effort": "high"}})[0]["openai"]["reasoning_effort"], "high")
        self.assertEqual(translate.with_speed({"speed": "warp"})[1], "standard")
        self.assertNotIn("reasoning_effort", cfg["openai"])  # 不改到使用者的设置
        body = openai_api._body({"model": "m", "reasoning_effort": "low"}, "hi", [], False, 0.2)
        self.assertEqual(body["reasoning_effort"], "low")
        self.assertNotIn("temperature", body)

    def test_manual_concurrency_capped_at_max_lanes(self):
        self.assertEqual(segments.workers(20, 30), segments.MAX_LANES)


class PanelGridTest(unittest.TestCase):
    def test_positions_kept_only_for_known_distinct_cells(self):
        labels = [{"panel": p, "role": "x", "en": "x", "zh": "x"} for p in "abc"]
        raw = [{"panel": "(a)", "row": 1, "col": 1}, {"panel": "b", "row": "1", "col": "2"}, {"panel": "c", "row": 1, "col": 2},
               {"panel": "z", "row": 2, "col": 1}, {"panel": "c", "row": 9, "col": 1}]
        self.assertEqual(figure_text.normalize_panels(raw, labels), [{"panel": "a", "row": 1, "col": 1}, {"panel": "b", "row": 1, "col": 2}])
        self.assertEqual(figure_text.normalize_panels([{"panel": "a", "row": 1, "col": 1}], labels), [])  # 只有一张小图不排格子


class TexCheckTest(unittest.TestCase):
    def test_text_with_subscripts_is_not_sent_back_for_repair(self):
        if not checks.shutil.which("node"):
            self.skipTest("node 不在")
        self.assertEqual(checks.tex_problems([["p1", "0.5\\text{ M H_2SO_4}", False], ["p2", "2.16\\text{ A mg_{Pt}}^{-1}", False]]), [])
        self.assertEqual(len(checks.tex_problems([["p3", "\\frac{a", False]])), 1)
