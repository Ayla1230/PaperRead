"""首页“今日用量”：按服务商、模型记当天的调用，Gemini 在太平洋时间午夜重置。"""
import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread import usage

GEMINI = {"preset": "gemini", "base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-3.8-flash"}


def ts(text: str) -> float:
    return dt.datetime.fromisoformat(text).timestamp()


class DailyUsageTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patcher = mock.patch.object(usage, "_ledger_path", lambda: Path(tmp.name) / "api_usage.json")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_gemini_resets_at_pacific_midnight_taiwan_time(self):
        # 夏令时：太平洋午夜 = 台湾 15:00；11 月 1 日之后冬令时 = 台湾 16:00
        _, reset = usage._window("pacific", ts("2026-10-28T13:50:00+00:00"))
        self.assertEqual(reset, ts("2026-10-29T15:00:00+08:00"))
        _, reset = usage._window("pacific", ts("2026-11-05T13:00:00+00:00"))
        self.assertEqual(reset, ts("2026-11-06T16:00:00+08:00"))

    def test_counts_calls_and_tokens_per_model_and_clears_after_reset(self):
        now = ts("2026-10-28T10:00:00+08:00")
        usage.record(GEMINI, {"input": 1200, "output": 300}, now=now)
        usage.record(GEMINI, {"input": 800, "output": 100}, now=now + 60)
        p = usage.summary(now=now + 120)["providers"][0]
        self.assertEqual((p["id"], p["name"], p["tz"]), ("gemini", "Google Gemini", "pacific"))
        self.assertEqual({k: p["models"][0][k] for k in ("model", "calls", "input", "output")},
                         {"model": "gemini-3.8-flash", "calls": 2, "input": 2000, "output": 400})
        self.assertEqual(p["reset_at"], ts("2026-10-28T15:00:00+08:00"))
        after = usage.summary(now=ts("2026-10-28T15:01:00+08:00"))["providers"][0]
        self.assertEqual(after["models"], [])

    def test_daily_quota_429_marks_exhausted_but_per_minute_does_not(self):
        detail = '{"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [{"violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}'
        self.assertTrue(usage.daily_quota_hit(detail))
        self.assertFalse(usage.daily_quota_hit('{"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}'))
        now = ts("2026-10-28T10:00:00+08:00")
        usage.record(GEMINI, exhausted=True, now=now)
        self.assertTrue(usage.summary(now=now)["providers"][0]["models"][0]["exhausted"])

    def test_user_limit_kept_across_days(self):
        usage.set_limit("gemini", "gemini-3.8-flash", 250)
        usage.record(GEMINI, {"input": 1, "output": 1})
        row = usage.summary()["providers"][0]["models"][0]
        self.assertEqual(row["limit"], 250)
        usage.set_limit("gemini", "gemini-3.8-flash", "")
        self.assertIsNone(usage.summary()["providers"][0]["models"][0]["limit"])
