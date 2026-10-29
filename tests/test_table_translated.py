"""表格整张没翻（表头和单元格还是英文）：当成问题请模型修一次（v1.6.4 的星号说明让模型把整张表照抄）。"""
import unittest

from easyread import prompts, translate

EN_TABLE = {"id": "tab1", "type": "table", "page": 2, "head": [["Paradigm", "Intellectual roots", "Nature of rents"]],
            "rows": [["(1) Attenuating competitive forces", "Mason, Bain", "Chamberlinean"]], "caption_zh": "表 1：策略典範"}
ZH_TABLE = {**EN_TABLE, "head": [["典範", "思想源流", "租的性質"]], "rows": [["(1) 削弱競爭力量", "Mason, Bain", "張伯倫式"]]}
NUM_TABLE = {"id": "tab2", "type": "table", "page": 3, "head": [["", "Mean", "SD"]], "rows": [["CAR", "0.02", "0.1"]]}


class TableTranslatedTest(unittest.TestCase):
    def test_english_table_flagged_for_cjk_targets_only(self):
        self.assertEqual(len(translate.untranslated_tables([EN_TABLE], "zh-TW")), 1)
        self.assertEqual(translate.untranslated_tables([ZH_TABLE], "zh-TW"), [])
        self.assertEqual(translate.untranslated_tables([EN_TABLE], "en"), [])
        self.assertEqual(translate.untranslated_tables([EN_TABLE], "fr"), [])

    def test_names_and_numbers_left_in_english_are_fine(self):
        names = {"id": "t", "type": "table", "head": [["作者", "年份"]], "rows": [["Porter", "1980"]]}
        self.assertEqual(translate.untranslated_tables([names], "zh"), [])

    def test_prompt_says_cells_must_be_translated(self):
        for target in ("zh-TW", "ja"):
            rule = prompts.rules(target)
            self.assertIn("每个单元格里的文字都要译成", rule)
            self.assertNotIn("一律照原文保留", rule)
            self.assertIn("一定要列 `image_labels`", rule)


class RepairFlowTest(unittest.TestCase):
    def test_english_table_is_sent_back_once_and_translated_version_kept(self):
        import json, tempfile, threading
        from pathlib import Path
        from unittest import mock
        from pypdf import PdfWriter
        from easyread import engines
        from easyread.store import Workspace, write_json_atomic
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        w = PdfWriter(); w.add_blank_page(width=100, height=100); w.write(root / "source.pdf")
        (root / "extract").mkdir()
        write_json_atomic(root / "paper.json", {"meta": {"page_count": 1, "target": "zh-TW"}, "blocks": [], "translation": {}})
        ws = Workspace(root)
        para = {"id": "p1-1", "type": "para", "page": 1, "en": "Strategy paradigms differ.", "zh": "策略典範各不相同。"}
        first = json.dumps({"blocks": [para, {**EN_TABLE, "page": 1}]})
        fixed = json.dumps({"blocks": [para, {**ZH_TABLE, "page": 1}]})
        calls = []

        def run(cfg, prompt, *a, **k):
            calls.append(prompt)
            return first if len(calls) == 1 else fixed
        with mock.patch.object(engines, "run", side_effect=run), mock.patch.object(translate.pdfwork, "locate"), \
                mock.patch.object(translate, "tex_problems", return_value=[]):
            translate._one_batch(ws, {"engine": "openai", "openai": {"vision": False}}, [1], 1, threading.Event(), lambda *a: None)
        self.assertEqual(len(calls), 2)
        self.assertIn("表格的表头和单元格还是英文", calls[1])
        table = next(b for b in ws.load("paper")["blocks"] if b["type"] == "table")
        self.assertEqual(table["head"][0][0], "典範")
