"""原页定位：页码给错时往别页找、找不到不画假框、每句话的逐行框（snts）。"""
import tempfile
import unittest
from pathlib import Path

from easyread import ask, pdfwork
from easyread.store import write_json_atomic


def chars(text, x, y, width=0.40, per_line=40):
    advance = width / per_line
    return [[letter, round(x + i % per_line * advance, 4), round(y + i // per_line * 0.02, 4),
             round(x + (i % per_line + 0.9) * advance, 4), round(y + i // per_line * 0.02 + 0.014, 4)]
            for i, letter in enumerate(text)]


def sents(en, zh, parts_en, parts_zh):
    """按句子切点做出 sents（JS 字串位置；这里都是 BMP 字元，和 Python 位置相同）。"""
    out, a, b = [], 0, 0
    for pe, pz in zip(parts_en, parts_zh):
        a += len(pe)
        b += len(pz)
        out.append([a, b])
    assert out[-1] == [len(en), len(zh)]
    return out


class SentenceLayoutTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "extract").mkdir()

    def page(self, n, text, x=0.1, y=0.1):
        write_json_atomic(self.root / f"extract/page-{n:03d}.chars.json", chars(text, x, y))

    def test_wrong_page_number_is_found_on_another_page(self):
        intro = "In truth, however, about ninety eight percent of products with environmental claims misled consumers."
        self.page(1, "Title page and abstract text that has nothing to do with the block. " * 2)
        self.page(2, intro)
        self.page(3, "Something else entirely on the third page of the paper. " * 2)
        self.page(4, "And the fourth page talks about institutional background. " * 2)
        write_json_atomic(self.root / "paper.json", {"blocks": [{"id": "p4-1", "page": 4, "type": "para", "en": intro}]})
        result = pdfwork.locate(self.root)["p4-1"]
        self.assertEqual(result["page"], 2)
        self.assertEqual(result["src"], "text")

    def test_unmatched_text_block_gets_no_guessed_box(self):
        self.page(1, "Completely different words appear on this page of the document. " * 2)
        write_json_atomic(self.root / "paper.json", {"blocks": [
            {"id": "p1-1", "page": 1, "type": "para", "en": "Completely different words appear on this page of the document."},
            {"id": "ghost", "page": 1, "type": "para", "en": "This paragraph is nowhere in the extracted text at all."},
            {"id": "eq1", "page": 1, "type": "math", "tex": "a=b"},
        ]})
        layout = pdfwork.locate(self.root)
        self.assertIn("p1-1", layout)
        self.assertNotIn("ghost", layout)  # 以前会被猜成一个大框，看起来像整页都对上了
        self.assertIn("eq1", layout)       # 公式这类没有英文的块照旧放在前后两块之间

    def test_each_sentence_gets_its_own_line_boxes(self):
        parts_en = ["Attitude had the strongest effect on intention. ", "Perceived behavioral control was also significant. ",
                    "Subjective norm had a weaker effect."]
        parts_zh = ["態度對意圖的影響最強。", "知覺行為控制也達顯著。", "主觀規範的影響較弱。"]
        en, zh = "".join(parts_en), "".join(parts_zh)
        self.page(1, en)
        write_json_atomic(self.root / "paper.json", {"blocks": [
            {"id": "p1-2", "page": 1, "type": "para", "en": en, "zh": zh, "sents": sents(en, zh, parts_en, parts_zh)}]})
        snts = pdfwork.locate(self.root)["p1-2"]["snts"]["p1-2"]
        self.assertEqual(len(snts), 3)
        self.assertTrue(all(snts))
        # 第二句从第 2 行中间开始：第一个框不该从栏的最左边起
        first_line = snts[1][0]
        self.assertGreater(first_line[0], 0.15)
        # 每一句的框依序往下，不互相包含
        tops = [boxes[0][1] for boxes in snts]
        self.assertEqual(tops, sorted(tops))

    def test_paragraph_without_sentence_alignment_has_no_snts(self):
        en = "One sentence only, with no alignment data from the translator."
        self.page(1, en)
        write_json_atomic(self.root / "paper.json", {"blocks": [{"id": "p1-1", "page": 1, "type": "para", "en": en}]})
        self.assertNotIn("snts", pdfwork.locate(self.root)["p1-1"])


class FakeLib:
    def __init__(self, ws):
        self._ws = ws

    def ws(self, pid):
        return self._ws if pid == self._ws.id else None


class AttachedPaperTextTest(unittest.TestCase):
    def test_text_comes_from_extracted_pages_with_page_markers(self):
        from easyread.store import Workspace
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "abc123"
            (root / "extract").mkdir(parents=True)
            (root / "extract/page-001.txt").write_text("Intro text", encoding="utf-8")
            (root / "extract/page-002.txt").write_text("Method   uses   PLS-SEM", encoding="utf-8")
            write_json_atomic(root / "paper.json", {"meta": {"title_en": "(anonymous)"}, "blocks": []})
            ws = Workspace(root)
            lib = FakeLib(ws)
            text, info = ask.paper_text(lib, ws.id)
            self.assertIn("〔第 2 頁〕\nMethod uses PLS-SEM", text)
            self.assertEqual(info["pages"], 2)
            self.assertEqual(ask.paper_info(lib, ws.id, "green.pdf")["title"], "green.pdf")
            long_text, long_info = ask.paper_text(lib, ws.id, budget=20)
            self.assertTrue(long_info["truncated"])


if __name__ == "__main__":
    unittest.main()
