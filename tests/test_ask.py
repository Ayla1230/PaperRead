"""文献库首页的“问 AI”（easyread/ask.py）：只用 API 模型、参考文献库译名、存对话。"""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from easyread import ask, chat, config
from easyread.store import write_json_atomic


class FakeLib:
    def __init__(self, root: Path, papers: dict):
        from easyread.store import Workspace
        self.spaces = {}
        for pid, paper in papers.items():
            folder = root / pid
            folder.mkdir()
            write_json_atomic(folder / "paper.json", paper)
            self.spaces[pid] = Workspace(folder)

    def list(self):
        return [{"id": pid} for pid in self.spaces]

    def ws(self, pid):
        return self.spaces.get(pid)


API_MODEL = {"id": "mine", "name": "My API", "engine": "openai", "preset": "", "base_url": "http://127.0.0.1:9/v1", "model": "m"}
CLI_MODEL = {"id": "opus", "name": "Claude Opus", "engine": "claude", "model": "opus"}


class AskTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        patcher = mock.patch.object(ask, "_path", lambda: self.root / "ask.json")
        patcher.start()
        self.addCleanup(patcher.stop)

    def cfg(self, models, default="opus"):
        return {**config.load(), "chat": {"models": models, "default": default}}

    def test_only_api_models_are_offered(self):
        listing = ask.models(self.cfg([CLI_MODEL, API_MODEL]))
        self.assertEqual([m["id"] for m in listing["models"]], ["mine"])
        self.assertEqual(listing["default"], "mine")  # 默认是命令列工具时改用能用的 API 模型

    def test_without_api_model_the_question_is_refused_with_a_hint(self):
        with self.assertRaises(ValueError):
            ask.engine_cfg(self.cfg([CLI_MODEL]), None)

    def test_glossary_hits_match_english_or_translation(self):
        lib = FakeLib(self.root, {
            "a": {"meta": {"short_zh": "有機農業"}, "glossary": [{"en": "perceived behavioral control", "zh": "知覺行為控制"}, {"en": "attitude", "zh": "態度"}]},
            "b": {"meta": {"title_en": "TAM study"}, "glossary": [{"en": "Perceived Behavioral Control", "zh": "知覺行為控制"}, {"en": "perceived usefulness", "zh": "知覺有用性"}]},
        })
        hits = ask.glossary_hits(lib, "Perceived behavioral control 和知覺有用性有關嗎？")
        by_en = {h["en"].casefold(): h for h in hits}
        self.assertEqual(set(by_en), {"perceived behavioral control", "perceived usefulness"})
        self.assertEqual(by_en["perceived behavioral control"]["papers"], ["有機農業", "TAM study"])
        self.assertIn("知覺行為控制", ask.prompt([{"role": "user", "content": "q"}], hits))

    def test_answer_is_streamed_and_saved_as_a_thread(self):
        lib = FakeLib(self.root, {})
        sent = []
        with mock.patch.object(config, "load", return_value=self.cfg([API_MODEL], "mine")), \
             mock.patch.object(chat, "stream", return_value=iter(["是的，", "知覺行為控制。"])) as stream:
            ask.stream_answer(lib, {"text": "PBC 的中文？"}, sent.append, threading.Event())
        self.assertEqual(stream.call_args[0][0]["engine"], "openai")
        self.assertEqual("".join(x.get("t", "") for x in sent), "是的，知覺行為控制。")
        self.assertTrue(sent[-1]["done"])
        saved = ask.threads()
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]["title"], "PBC 的中文？")
        self.assertEqual([m["role"] for m in saved[0]["messages"]], ["user", "assistant"])
        # 接着问：同一个对话，上一轮会带进提示词
        with mock.patch.object(config, "load", return_value=self.cfg([API_MODEL], "mine")), \
             mock.patch.object(chat, "stream", return_value=iter(["好"])) as stream:
            ask.stream_answer(lib, {"text": "那 SN 呢？", "thread": saved[0]["id"]}, sent.append, threading.Event())
        self.assertIn("PBC 的中文？", stream.call_args[0][1])
        self.assertEqual(len(ask.threads()[0]["messages"]), 4)
        self.assertEqual(ask.delete(saved[0]["id"]), [])


if __name__ == "__main__":
    unittest.main()
