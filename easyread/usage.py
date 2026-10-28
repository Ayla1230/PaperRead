"""翻译花了多少：token 数，Claude Code 订阅还能看到 5 小时 / 7 天额度用了百分之几。

每次调用模型后，各引擎把返回里的用量交给 Meter；整篇翻译时 Meter 的累计写进 job.json 给页面显示。
input 是全部输入 token（含命中缓存的部分），cached 是其中命中缓存的，output 是输出。
"""
from __future__ import annotations

import threading
import time

from . import config
from .store import read_json, write_json_atomic


class Meter:
    """一次翻译任务的累计用量。并发翻译时多个线程一起往里加。"""

    def __init__(self, engine: str = ""):
        self._lock = threading.Lock()
        self.data: dict = {"engine": engine, "calls": 0, "input": 0, "cached": 0, "output": 0}

    def add(self, input: int = 0, cached: int = 0, output: int = 0, cost_usd: float | None = None, limits: dict | None = None,
            context_window: int | None = None):
        with self._lock:
            d = self.data
            d["calls"] += 1
            # 最近一次调用的上下文有多大（输入 + 输出）：问 AI 时每次都把之前的对话一起发，这就是当前对话占了多少上下文
            d["context"] = {"cached": int(cached or 0), "fresh": int(input or 0) - int(cached or 0), "output": int(output or 0)}
            if context_window:
                d["context_window"] = int(context_window)
            d["input"] += int(input or 0)
            d["cached"] += int(cached or 0)
            d["output"] += int(output or 0)
            if cost_usd is not None:
                d["cost_usd"] = round(d.get("cost_usd", 0) + float(cost_usd), 4)
            if limits:
                d["limits"] = limits  # 整个账号的额度（同时在用 Claude Code 干别的也算在里面），只记最新的
        if limits:
            remember(limits)

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self.data)


# ---------- 最近一次看到的订阅额度（全局，新对话也能显示） ----------
def _limits_path():
    return config.library_dir() / ".limits.json" if config.temp_library() else config.HOME / "limits.json"


def remember(limits: dict) -> None:
    try:
        write_json_atomic(_limits_path(), {"limits": limits, "at": int(time.time())})
    except OSError:
        pass


def latest() -> dict | None:
    """{"limits": {...}, "at": 时间戳}；还没用 Claude Code 订阅调用过就是 None。"""
    return read_json(_limits_path(), None)


def merge(total: dict | None, run: dict) -> dict:
    """把这次的用量加进这篇论文的累计（job.json 的 usage_total）。"""
    out = dict(total or {})
    for k in ("calls", "input", "cached", "output"):
        out[k] = int(out.get(k, 0)) + int(run.get(k, 0))
    if "cost_usd" in run:
        out["cost_usd"] = round(out.get("cost_usd", 0) + run["cost_usd"], 4)
    for k in ("engine", "limits"):
        if run.get(k):
            out[k] = run[k]
    return out


# ---------- 各引擎返回的用量 ----------
def from_claude(result: dict, rate_event: dict | None) -> dict:
    """claude -p --output-format stream-json 的 result 行，和其中的 rate_limit_event。"""
    u = result.get("usage") or {}
    cached = int(u.get("cache_read_input_tokens") or 0)
    rec = {"input": int(u.get("input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0) + cached,
           "cached": cached, "output": int(u.get("output_tokens") or 0)}
    windows = ((rate_event or {}).get("rate_limit_info") or {}).get("unifiedWindows") or {}
    if windows:  # 有额度信息就是订阅；订阅时 total_cost_usd 只是按官方价折算，不是真花的钱，不记
        rec["limits"] = {k: {"used": w.get("utilization"), "resets_at": w.get("resetsAt")}
                         for k, w in windows.items() if isinstance(w, dict)}
    elif result.get("total_cost_usd") is not None:
        rec["cost_usd"] = float(result["total_cost_usd"])
    window = next((m.get("contextWindow") for m in (result.get("modelUsage") or {}).values() if m.get("contextWindow")), None)
    if window:
        rec["context_window"] = window
    return rec


def from_antigravity(res: dict) -> dict:
    """agy --output-format json 的返回内容。"""
    u = (res or {}).get("usage") or {}
    return {"input": int(u.get("input_tokens") or 0), "cached": int(u.get("cache_read_tokens") or 0),
            "output": int(u.get("output_tokens") or 0)}


def from_codex(event: dict) -> dict:
    """codex exec --json 的 turn.completed 事件。"""
    u = event.get("usage") or {}
    return {"input": int(u.get("input_tokens") or 0), "cached": int(u.get("cached_input_tokens") or 0),
            "output": int(u.get("output_tokens") or 0)}


def from_openai(res: dict) -> dict:
    """Chat Completions 或 Responses 返回的 usage（DeepSeek 的缓存命中数字段名不一样）。"""
    u = (res or {}).get("usage") or {}
    if "prompt_tokens" in u:  # Chat Completions
        details = u.get("prompt_tokens_details") or {}
        cached = details.get("cached_tokens") or u.get("prompt_cache_hit_tokens") or 0
        return {"input": int(u.get("prompt_tokens") or 0), "cached": int(cached), "output": int(u.get("completion_tokens") or 0)}
    details = u.get("input_tokens_details") or {}
    return {"input": int(u.get("input_tokens") or 0), "cached": int(details.get("cached_tokens") or 0),
            "output": int(u.get("output_tokens") or 0)}


# ---------- 今天用了多少 API（首页“用量”卡片） ----------
# 服务商没有接口能查剩余额度，所以自己记：每次调用 API 后按服务商、模型累加当天的次数和 token。
# Gemini 的每日额度在太平洋时间午夜重置（官方文档），其他服务商按本机时间的午夜算“今天”。
# 服务商回 429 且说明是每日额度用完，就标记为“已用完”，到重置时间自动解除。
import datetime as _dt
import re as _re

_ledger_lock = threading.Lock()
_PACIFIC_HOSTS = ("generativelanguage.googleapis.com",)


def _ledger_path():
    return config.library_dir() / ".api_usage.json" if config.temp_library() else config.HOME / "api_usage.json"


def _nth_sunday(year: int, month: int, n: int) -> _dt.date:
    first = _dt.date(year, month, 1)
    return first + _dt.timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))


def _pacific_offset(utc: _dt.datetime) -> int:
    """太平洋时间相对 UTC 差几小时（夏令时 -7，其余 -8）。不用 zoneinfo：Windows 打包版没有时区资料库。"""
    y = utc.year
    start = _dt.datetime.combine(_nth_sunday(y, 3, 2), _dt.time(10), _dt.timezone.utc)  # 3 月第二个周日 02:00 PST
    end = _dt.datetime.combine(_nth_sunday(y, 11, 1), _dt.time(9), _dt.timezone.utc)    # 11 月第一个周日 02:00 PDT
    return -7 if start <= utc < end else -8


def _window(tz: str, now: float) -> tuple[str, float]:
    """(今天的日期, 下次重置的时间戳)。"""
    utc = _dt.datetime.fromtimestamp(now, _dt.timezone.utc)
    if tz == "pacific":
        local = utc + _dt.timedelta(hours=_pacific_offset(utc))
        midnight = _dt.datetime.combine(local.date() + _dt.timedelta(days=1), _dt.time(0), _dt.timezone.utc)
        reset = midnight - _dt.timedelta(hours=_pacific_offset(midnight - _dt.timedelta(hours=8)))
        return local.date().isoformat(), reset.timestamp()
    local = _dt.datetime.fromtimestamp(now)
    midnight = _dt.datetime.combine(local.date() + _dt.timedelta(days=1), _dt.time(0))
    return local.date().isoformat(), midnight.timestamp()


def provider_of(o: dict) -> dict:
    """接口设置 → {"id", "name", "tz", "free", "usage_url"}。"""
    from . import presets
    base = (o.get("base_url") or "").strip().lower()
    host = _re.sub(r"^\w+://", "", base).split("/")[0]
    pid = o.get("preset") or ""
    found = next((p for p in presets.PRESETS if (pid and p["id"] == pid) or (p.get("base_url") and host and host in p["base_url"].lower())), None)
    if found:
        pid = found["id"]
    pid = pid or host or "api"
    tz = "pacific" if any(h in base for h in _PACIFIC_HOSTS) or pid == "gemini" else "local"
    return {"id": pid, "name": (found or {}).get("name") or host or "API", "tz": tz, "free": bool((found or {}).get("free")),
            "usage_url": "https://aistudio.google.com/rate-limit" if tz == "pacific" else ""}


def _fresh(entry: dict, tz: str, now: float) -> dict:
    day, _ = _window(tz, now)
    if entry.get("day") != day:
        entry.update(day=day, models={}, exhausted={})
    return entry


def record(o: dict, rec: dict | None = None, exhausted: bool = False, now: float | None = None) -> None:
    """记一次 API 调用；exhausted=True 表示服务商说今天的额度用完了。出错只跳过，不影响翻译。"""
    try:
        now = time.time() if now is None else now
        prov, model = provider_of(o), (o.get("model") or "").strip() or "?"
        with _ledger_lock:
            data = read_json(_ledger_path(), None) or {}
            entry = _fresh(data.setdefault("providers", {}).setdefault(prov["id"], {}), prov["tz"], now)
            entry.update(name=prov["name"], tz=prov["tz"], free=prov["free"], usage_url=prov["usage_url"])
            m = entry["models"].setdefault(model, {"calls": 0, "input": 0, "output": 0})
            if exhausted:
                entry["exhausted"][model] = True
                m["limited"] = m.get("limited", 0) + 1
            else:
                m["calls"] += 1
                m["input"] += int((rec or {}).get("input") or 0)
                m["output"] += int((rec or {}).get("output") or 0)
            write_json_atomic(_ledger_path(), data)
    except Exception:  # noqa: BLE001
        pass


def daily_quota_hit(detail: str) -> bool:
    """429 的内容是不是“每日额度用完”（Gemini 的 quotaId 带 PerDay），而不是每分钟限流。"""
    return bool(_re.search(r"PerDay|per[ _-]?day|daily", detail or "", _re.I))


def set_limit(provider: str, model: str, limit) -> dict:
    """使用者自己填的每日上限（次数）。填 0 或空就拿掉。"""
    with _ledger_lock:
        data = read_json(_ledger_path(), None) or {}
        limits = data.setdefault("limits", {})
        key = provider + "/" + model
        try:
            n = int(limit or 0)
        except (TypeError, ValueError):
            n = 0
        if n > 0:
            limits[key] = n
        else:
            limits.pop(key, None)
        write_json_atomic(_ledger_path(), data)
    return summary()


def summary(now: float | None = None) -> dict:
    now = time.time() if now is None else now
    data = read_json(_ledger_path(), None) or {}
    limits = data.get("limits") or {}
    out = []
    for pid, entry in (data.get("providers") or {}).items():
        tz = entry.get("tz") or "local"
        day, reset = _window(tz, now)
        models = entry.get("models") if entry.get("day") == day else {}
        exhausted = entry.get("exhausted") if entry.get("day") == day else {}
        keys = set(models or {}) | {k.split("/", 1)[1] for k in limits if k.startswith(pid + "/")}
        rows = [{"model": k, **(models or {}).get(k, {"calls": 0, "input": 0, "output": 0}),
                 "exhausted": bool((exhausted or {}).get(k)), "limit": limits.get(pid + "/" + k)} for k in sorted(keys)]
        out.append({"id": pid, "name": entry.get("name") or pid, "tz": tz, "free": bool(entry.get("free")), "usage_url": entry.get("usage_url") or "",
                    "day": day, "reset_at": int(reset), "models": rows})
    out.sort(key=lambda p: -sum(r["calls"] for r in p["models"]))
    return {"providers": out, "claude": latest(), "now": int(now)}
