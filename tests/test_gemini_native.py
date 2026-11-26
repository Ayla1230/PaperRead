"""Gemini 原生端点：新的 AQ. 金钥在 OpenAI 兼容端点会被拒，Google 的地址一律走 :generateContent。"""
import io
import json
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from easyread import gemini_native, openai_api, usage

O = {"preset": "gemini", "base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-3.5-flash-lite",
     "api_key": "AQ.Ab8_test", "vision": True}


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def ok(payload):
    return FakeResp(json.dumps(payload).encode())


def http_error(code, body):
    return urllib.error.HTTPError("https://x", code, "err", {}, io.BytesIO(json.dumps(body).encode()))


ANSWER = {"candidates": [{"content": {"parts": [{"text": "thinking…", "thought": True}, {"text": '{"blocks": []}'}]}, "finishReason": "STOP"}],
          "usageMetadata": {"promptTokenCount": 1200, "candidatesTokenCount": 300, "thoughtsTokenCount": 50}}
PER_MINUTE = {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [
    {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "quotaValue": "5"}]},
    {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "7s"}]}}
PER_DAY = {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [
    {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{"quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
     "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier", "quotaDimensions": {"location": "global", "model": "gemini-3.8-flash"}, "quotaValue": "20"}]}]}}


class NativeTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        p = mock.patch.object(usage, "_ledger_path", lambda: self.tmp / "api_usage.json"); p.start(); self.addCleanup(p.stop)
        self.sent = []

    def urlopen(self, responses):
        def fake(req, *a, **k):
            self.sent.append(req)
            r = responses.pop(0)
            if isinstance(r, Exception):
                raise r
            return r
        return mock.patch.object(openai_api.http, "urlopen", side_effect=fake)

    def test_aq_key_goes_to_native_endpoint_with_goog_header(self):
        img = self.tmp / "p1.png"; img.write_bytes(b"\x89PNG fake")
        with self.urlopen([ok(ANSWER)]):
            text = openai_api.complete(O, "translate", [img], json_mode=True)
        self.assertEqual(text, '{"blocks": []}')  # 思考内容不算进回答
        req = self.sent[0]
        self.assertEqual(req.full_url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent")
        headers = {k.lower(): v for k, v in req.header_items()}
        self.assertEqual(headers.get("x-goog-api-key"), "AQ.Ab8_test")
        self.assertNotIn("authorization", headers)  # 只带一种凭证
        body = json.loads(req.data)
        self.assertEqual(body["contents"][0]["parts"][1]["inline_data"]["mime_type"], "image/png")
        self.assertEqual(body["generationConfig"]["responseMimeType"], "application/json")
        row = usage.summary()["providers"][0]["models"][0]
        self.assertEqual((row["calls"], row["input"], row["output"]), (1, 1200, 350))

    def test_per_minute_limit_waits_retry_delay_then_succeeds(self):
        waits = []
        with self.urlopen([http_error(429, PER_MINUTE), ok(ANSWER)]), mock.patch.object(openai_api, "_sleep", side_effect=lambda s, c: waits.append(s)):
            self.assertEqual(openai_api.complete(O, "x", []), '{"blocks": []}')
        self.assertEqual(waits, [8.0])  # Google 说的 7 秒 + 1

    def test_daily_quota_stops_at_once_and_fills_limit(self):
        o = {**O, "model": "gemini-3.8-flash"}
        with self.urlopen([http_error(429, PER_DAY)]), mock.patch.object(openai_api, "_sleep") as sleep:
            with self.assertRaises(openai_api.QuotaExhausted) as cm:
                openai_api.complete(o, "x", [])
        sleep.assert_not_called()
        self.assertIn("免费额度用完了", str(cm.exception))
        row = usage.summary()["providers"][0]["models"][0]
        self.assertTrue(row["exhausted"])
        self.assertEqual(row["limit"], 20)

    def test_unsupported_thinking_setting_dropped_and_resent(self):
        o = {**O, "reasoning_effort": "low"}
        err = http_error(400, {"error": {"message": "Invalid JSON payload received. Unknown name \"thinkingLevel\""}})
        with self.urlopen([err, ok(ANSWER)]):
            openai_api.complete(o, "x", [])
        self.assertIn("thinkingConfig", json.loads(self.sent[0].data)["generationConfig"])
        self.assertNotIn("thinkingConfig", json.loads(self.sent[1].data).get("generationConfig") or {})

    def test_stream_reads_sse_events_and_counts_usage(self):
        events = [{"candidates": [{"content": {"parts": [{"text": "你好"}]}}]},
                  {"candidates": [{"content": {"parts": [{"text": "，世界"}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 4}}]
        raw = "".join("data: " + json.dumps(e, ensure_ascii=False) + "\r\n\r\n" for e in events).encode()
        with self.urlopen([FakeResp(raw)]):
            out = "".join(openai_api.stream(O, "hi", threading.Event()))
        self.assertEqual(out, "你好，世界")
        self.assertTrue(self.sent[0].full_url.endswith(":streamGenerateContent?alt=sse"))
        self.assertEqual(usage.summary()["providers"][0]["models"][0]["calls"], 1)

    def test_model_list_and_other_providers_unchanged(self):
        with self.urlopen([ok({"models": [{"name": "models/gemini-3.5-flash-lite", "supportedGenerationMethods": ["generateContent"]},
                                          {"name": "models/text-embedding-005", "supportedGenerationMethods": ["embedContent"]}]})]):
            self.assertEqual(openai_api.models(O), ["gemini-3.5-flash-lite"])
        self.assertFalse(gemini_native.is_native({"base_url": "https://api.openai.com/v1"}))
        self.assertEqual(gemini_native.root({"base_url": "https://generativelanguage.googleapis.com/v1beta"}), "https://generativelanguage.googleapis.com/v1beta")
