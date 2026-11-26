"""Gemini 原生接口（generativelanguage.googleapis.com 的 :generateContent）。

AI Studio 从 2026 年起只发新的 “AQ.” 金鑰。新金鑰在 OpenAI 兼容端点（/v1beta/openai）会被拒绝
（400 Multiple authentication credentials / 401），在原生端点用 x-goog-api-key 头就能用；旧的 AIza 金鑰两边都能用。
所以接口地址是 Google 的，就一律走原生端点，用户不用改任何设置。

请求、重试、取消、用量都沿用 openai_api.py，这里只负责：网址和头、请求内容、把回答拆成文字和用量。
"""
from __future__ import annotations

import base64
import json
import mimetypes
import re
from pathlib import Path

from . import __version__
from .engines import EngineError
from .i18n import tr

HOSTS = ("generativelanguage.googleapis.com",)


def is_native(o: dict) -> bool:
    base = (o.get("base_url") or "").lower()
    return any(h in base for h in HOSTS)


def root(o: dict) -> str:
    """https://generativelanguage.googleapis.com/v1beta/openai → https://generativelanguage.googleapis.com/v1beta"""
    base = (o.get("base_url") or "").strip().rstrip("/")
    base = re.sub(r"/openai$", "", base)
    if not re.search(r"/v1(beta\d*|alpha)?$", base):
        base += "/v1beta"
    return base


def model_id(o: dict) -> str:
    return str(o.get("model") or "").strip().removeprefix("models/")


def url(o: dict, stream: bool) -> str:
    return root(o) + "/models/" + model_id(o) + (":streamGenerateContent?alt=sse" if stream else ":generateContent")


def headers(o: dict, stream: bool = False) -> dict:
    # 只带一种凭证：同时带 Authorization 和 key 会被拒（Multiple authentication credentials）
    h = {"Content-Type": "application/json", "User-Agent": f"PaperRead/{__version__}"}
    if stream:
        h["Accept"] = "text/event-stream"
    if o.get("api_key"):
        h["x-goog-api-key"] = o["api_key"]
    return h


_LEVEL = {"none": "minimal", "minimal": "minimal", "low": "low", "medium": "medium", "high": "high"}


def body(o: dict, prompt: str, images: list[Path], temperature: float | None, json_mode: bool = False) -> dict:
    parts: list[dict] = [{"text": prompt}]
    if o.get("vision"):
        for p in images:
            parts.append({"inline_data": {"mime_type": mimetypes.guess_type(str(p))[0] or "image/png",
                                          "data": base64.b64encode(Path(p).read_bytes()).decode()}})
    config: dict = {}
    effort = o.get("reasoning_effort")
    if effort and effort in _LEVEL:
        config["thinkingConfig"] = {"thinkingLevel": _LEVEL[effort]}
    elif temperature is not None:
        config["temperature"] = temperature
    if json_mode:
        config["responseMimeType"] = "application/json"
    out = {"contents": [{"role": "user", "parts": parts}]}
    if config:
        out["generationConfig"] = config
    return out


def drop_rejected(b: dict, detail: str) -> bool:
    """400 说某个设定不认得（旧模型没有 thinkingLevel、不支持 JSON 模式……）：拿掉再发。改了就回 True。"""
    config = b.get("generationConfig") or {}
    for key, names in (("thinkingConfig", ("thinking", "thinkingLevel", "thinking_level")),
                       ("responseMimeType", ("responseMimeType", "response_mime_type", "mime")),
                       ("temperature", ("temperature",))):
        if key in config and any(n.lower() in detail.lower() for n in names):
            config.pop(key)
            if not config:
                b.pop("generationConfig", None)
            return True
    return False


def usage(res: dict) -> dict:
    u = (res or {}).get("usageMetadata") or {}
    return {"input": int(u.get("promptTokenCount") or 0), "cached": int(u.get("cachedContentTokenCount") or 0),
            "output": int(u.get("candidatesTokenCount") or 0) + int(u.get("thoughtsTokenCount") or 0)}


def as_openai_usage(res: dict) -> dict:
    """给 usage.from_openai 用的形状（Chat Completions 的 usage）。"""
    u = usage(res)
    return {"usage": {"prompt_tokens": u["input"], "completion_tokens": u["output"], "prompt_tokens_details": {"cached_tokens": u["cached"]}}}


def _parts_text(res: dict) -> str:
    cands = (res or {}).get("candidates") or []
    if not cands:
        return ""
    return "".join(p.get("text") or "" for p in ((cands[0].get("content") or {}).get("parts") or []) if not p.get("thought"))


def finish(res: dict) -> str:
    cands = (res or {}).get("candidates") or []
    return str((cands[0] if cands else {}).get("finishReason") or "")


def check(res: dict, truncated) -> None:
    """回答被挡、被截断：丢清楚的错误。"""
    block = ((res or {}).get("promptFeedback") or {}).get("blockReason")
    if block:
        raise EngineError(tr("模型拒绝回答（Google 的内容过滤：{reason}）", reason=block))
    reason = finish(res)
    if reason == "MAX_TOKENS":
        raise truncated()
    if reason in ("SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"):
        raise EngineError(tr("模型输出被服务商的内容过滤器中断了。"))


def text(res, truncated) -> str:
    if not isinstance(res, dict) or ("candidates" not in res and "promptFeedback" not in res):
        raise EngineError(tr("接口返回格式不对：{res}", res=str(res)[:300]))
    check(res, truncated)
    return _parts_text(res)


def piece(ev: dict) -> str:
    """串流的一个事件里的文字（思考内容不算）。"""
    return _parts_text(ev)


def retry_delay(detail: str) -> float | None:
    """429 内容里的 RetryInfo：retryDelay "37s"。"""
    m = re.search(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"', detail or "")
    return float(m.group(1)) if m else None


def quota_value(detail: str) -> int | None:
    """429 内容里每日额度的上限（QuotaFailure 的 quotaValue），用来自动填首页“用量”的每日上限。"""
    try:
        data = json.loads(detail)
    except (TypeError, ValueError):
        data = None
    if isinstance(data, list) and data:
        data = data[0]
    for d in (((data or {}).get("error") or {}).get("details") or []) if isinstance(data, dict) else []:
        for v in d.get("violations") or []:
            if "PerDay" in str(v.get("quotaId") or "") and str(v.get("quotaValue") or "").isdigit():
                return int(v["quotaValue"])
    i = (detail or "").find("PerDay")  # 内容被截断、不是完整 JSON：在 PerDay 后面找
    m = re.search(r'"quotaValue"\s*:\s*"?(\d+)', detail[i:i + 600]) if i >= 0 else None
    return int(m.group(1)) if m else None


def model_list(res) -> list[str]:
    items = (res or {}).get("models") or []
    out = []
    for m in items:
        if not isinstance(m, dict):
            continue
        methods = m.get("supportedGenerationMethods") or ["generateContent"]
        if "generateContent" in methods:
            out.append(str(m.get("name") or "").removeprefix("models/"))
    return sorted({x for x in out if x})


def loads(raw: bytes):
    return json.loads(raw)
