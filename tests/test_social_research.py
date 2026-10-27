"""研究探索的社會科學功能：期刊清單、管理學期刊縮寫、比較報告的變數與量表對照。"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread import prefs, research_v2
from easyread.research import comparison


class JournalListTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        patcher = mock.patch.object(prefs, "path", lambda: Path(temp.name) / "prefs.json")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_presets_fit_one_source_lookup(self):
        for preset in research_v2.JOURNAL_PRESETS:
            self.assertLessEqual(len(preset["journals"]), 10, preset["name"])
            self.assertEqual(research_v2._source_terms(", ".join(preset["journals"])), preset["journals"])

    def test_custom_lists_are_cleaned_and_saved(self):
        saved = research_v2.save_journal_lists([
            {"name": "  我的  清單 ", "journals": "Agricultural Systems，Food Policy\nFood Policy"},
            {"name": "我的 清單", "journals": ["Duplicate name is dropped"]},
            {"name": "", "journals": ["No name"]},
        ])
        self.assertEqual(saved["custom"], [{"name": "我的 清單", "journals": ["Agricultural Systems", "Food Policy"]}])
        self.assertEqual(research_v2.journal_lists()["custom"], saved["custom"])

    def test_more_than_ten_journals_is_rejected(self):
        with self.assertRaises(ValueError):
            research_v2.save_journal_lists([{"name": "x", "journals": [f"J{i}" for i in range(11)]}])

    def test_management_acronyms_resolve(self):
        self.assertEqual(research_v2._source_terms("AMJ SMJ JOM"), ["AMJ", "SMJ", "JOM"])
        self.assertEqual(research_v2.SOURCE_ALIASES["AMJ"], "Academy of Management Journal")


class ComparisonPromptTest(unittest.TestCase):
    papers = [{"title": "A"}, {"title": "B"}]

    def test_social_dimensions_add_variable_and_scale_table(self):
        text = comparison._report_prompt(self.papers, ["a", "b"], ["研究問題", "測量量表與來源"], "")
        self.assertIn("理論框架與研究變數對照", text)
        self.assertIn("未報告", text)

    def test_method_dimensions_keep_the_general_report(self):
        text = comparison._report_prompt(self.papers, ["a", "b"], ["核心方法"], "")
        self.assertNotIn("理論框架與研究變數對照", text)
        self.assertNotIn("CV 研究助理", text)


if __name__ == "__main__":
    unittest.main()
