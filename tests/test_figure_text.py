"""图内文字中英对照（figure_text.py）：整理模型给的标签、看图后写回 paper.json。"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread import engines, figure_text
from easyread.store import Workspace, write_json_atomic


class NormalizeTest(unittest.TestCase):
    def test_roles_are_normalized_and_empty_items_dropped(self):
        labels = figure_text.normalize_labels([
            {"role": "X-axis", "en": "Year", "zh": "年份"}, {"role": "y_axis", "en": "CAR (%)", "zh": "累積異常報酬（%）"},
            {"role": "weird", "en": "Panel A", "zh": "A 小圖"}, {"en": "", "zh": ""}, "not a dict",
            {"role": "x", "en": "Year", "zh": "年份"},
        ])
        self.assertEqual([x["role"] for x in labels], ["x", "y", "label"])
        self.assertEqual(figure_text.joined(labels, "zh"), "年份；累積異常報酬（%）；A 小圖")


class ExtractTest(unittest.TestCase):
    def test_labels_are_written_back_to_the_figure_block(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "figures").mkdir()
            Image.new("RGB", (40, 30), "white").save(root / "figures" / "crop-1-abc.webp", "WEBP")
            write_json_atomic(root / "paper.json", {"meta": {"target": "zh"}, "blocks": [
                {"id": "fig1", "type": "figure", "page": 1, "src": "figures/crop-1-abc.webp", "caption_en": "Fig. 1"}]})
            ws = Workspace(root)
            cfg = {"engine": "openai", "openai": {"base_url": "http://127.0.0.1:9/v1", "model": "m", "vision": False}}
            answer = json.dumps({"labels": [{"role": "x", "en": "Year", "zh": "年份"}]})
            with mock.patch.object(engines, "run", return_value=answer) as run:
                labels = figure_text.extract(ws, "fig1", cfg)
            sent_cfg, _, _, images = run.call_args[0][:4]
            self.assertTrue(sent_cfg["openai"]["vision"])          # 这次一定附图
            # macOS 的暂存目录是 /var → /private/var、Windows 可能是 8.3 短路径：比较解析后的真实路径
            self.assertEqual([Path(p).resolve() for p in images], [(root / "figures" / "crop-1-abc.webp").resolve()])
            self.assertFalse(cfg["openai"]["vision"])               # 不改动原本的设定
            block = ws.load("paper")["blocks"][0]
            self.assertEqual(block["image_labels"], labels)
            self.assertEqual((block["image_en"], block["image_zh"]), ("Year", "年份"))

    def test_no_labels_is_an_error_and_nothing_is_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "figures").mkdir()
            (root / "figures" / "a.webp").write_bytes(b"x")
            write_json_atomic(root / "paper.json", {"meta": {}, "blocks": [{"id": "fig1", "type": "figure", "page": 1, "src": "figures/a.webp"}]})
            ws = Workspace(root)
            cfg = {"engine": "openai", "openai": {"base_url": "http://127.0.0.1:9/v1", "model": "m"}}
            with mock.patch.object(engines, "run", return_value='{"labels": []}'), self.assertRaises(engines.EngineError):
                figure_text.extract(ws, "fig1", cfg)
            self.assertNotIn("image_labels", ws.load("paper")["blocks"][0])


if __name__ == "__main__":
    unittest.main()
