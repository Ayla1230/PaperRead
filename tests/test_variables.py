"""研究变数：模型给的角色、名称整理成固定格式；提示词带上整篇原文。"""
import unittest

from easyread import variables


class VariablesTest(unittest.TestCase):
    def test_roles_names_and_terms_are_normalized(self):
        raw = {"variables": [
            {"role": "Independent variable", "en": "Perceived behavioral control", "zh": "知覺行為控制", "abbr": "PBC", "terms": ["behavioral control", "PBC", "x"]},
            {"role": "mediator", "en": "Attitude", "zh": "態度"},
            {"role": "outcome", "en": "Adoption intention", "zh": "採用意願", "terms": ["intention to adopt"]},
            {"role": "weird", "en": "Something"},
            {"role": "iv", "en": "", "zh": ""},
            {"role": "iv", "en": "Perceived behavioral control", "zh": "知覺行為控制"},
        ]}
        out = variables.normalize(raw)
        self.assertEqual([v["role"] for v in out], ["iv", "med", "dv"])
        self.assertEqual(out[0]["terms"], ["Perceived behavioral control", "知覺行為控制", "PBC", "behavioral control"])  # 去重、丢掉太短的
        self.assertEqual(variables.normalize("not a list"), [])

    def test_prompt_contains_paper_text_and_roles(self):
        paper = {"meta": {"title_en": "Organic farming adoption"}, "blocks": [
            {"type": "heading", "en": "Hypotheses"}, {"type": "para", "en": "PBC positively affects intention.‖ Attitude mediates it."}]}
        text = variables.prompt(paper, "zh-TW")
        self.assertIn("PBC positively affects intention. Attitude mediates it.", text)
        for role in ("iv：", "dv：", "med：", "mod：", "ctrl："):
            self.assertIn(role, text)
