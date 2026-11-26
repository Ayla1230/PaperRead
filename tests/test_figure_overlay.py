"""翻译版的图：图内文字在图上的位置。向量图从 PDF 文字层找；扫描图用模型给的位置。"""
import unittest

from easyread import figure_overlay, figure_text


def chars(text, x0, y, w=0.01, h=0.012):
    return [[ch, x0 + i * w, y, x0 + (i + 1) * w, y + h] for i, ch in enumerate(text)]


class OverlayTest(unittest.TestCase):
    def test_vector_labels_found_inside_crop_and_made_relative(self):
        page = chars("Body text above", 0.1, 0.05) + chars("Greenwashing firms", 0.2, 0.30) + chars("Non-greenwashing firms", 0.5, 0.30) + chars("Event day", 0.4, 0.58)
        crop = [0.1, 0.25, 0.9, 0.65]
        labels = [{"role": "legend", "en": "Greenwashing firms", "zh": "漂綠企業"}, {"role": "legend", "en": "Non-greenwashing firms", "zh": "非漂綠企業"},
                  {"role": "x", "en": "Event day", "zh": "事件日"}, {"role": "title", "en": "Body text above", "zh": "不在圖裡"}]
        found = figure_overlay.vector_boxes(page, crop, labels)
        self.assertEqual(sorted(found), [0, 1, 2])  # 图外的字不算
        self.assertAlmostEqual(found[0][0], 0.2)    # “Greenwashing firms”不会配到“Non-greenwashing”里面那段
        self.assertAlmostEqual(found[1][0], 0.5)
        rel = figure_overlay._relative(found[2], crop)
        self.assertAlmostEqual(rel[0], (0.4 - 0.1) / 0.8, places=3)

    def test_model_positions_used_for_scanned_figures(self):
        block = {"page": 1, "image_labels": [{"role": "x", "en": "Year", "zh": "年份", "pbox": [0.3, 0.6, 0.5, 0.62]},
                                             {"role": "y", "en": "CAR", "zh": "累積異常報酬", "box": [0.02, 0.2, 0.06, 0.8]}]}
        self.assertTrue(figure_overlay.place(__import__("pathlib").Path("/nonexistent"), block, [0.1, 0.2, 0.9, 0.7]))
        self.assertEqual(block["image_labels"][0]["ibox"], [0.25, 0.8, 0.5, 0.84])  # 整页坐标换成相对截图
        self.assertEqual(block["image_labels"][1]["ibox"], [0.02, 0.2, 0.06, 0.8])

    def test_label_boxes_survive_normalization_and_0_1000_scale(self):
        labels = figure_text.normalize_labels([{"role": "x", "en": "Year", "zh": "年份", "box": [300, 600, 500, 620]},
                                               {"role": "y", "en": "CAR", "zh": "CAR", "pbox": [0.5, 0.2, 0.4, 0.3]}])
        self.assertEqual(labels[0]["box"], [0.3, 0.6, 0.5, 0.62])
        self.assertNotIn("pbox", labels[1])  # 左右颠倒的框不收


class CaptionTrimTest(unittest.TestCase):
    def test_single_line_caption_is_cut_from_crop(self):
        from easyread import figures
        loc = {"page": 1, "box": [0.09, 0.25, 0.85, 0.63], "cap": [0.1, 0.607, 0.52, 0.621]}
        box = figures._display_box(loc["box"], loc, {"fig1": loc}, 1)
        self.assertLess(box[3], 0.607)
