"""文献库首页的“问 AI”：还没打开（甚至还没导入）论文时也能问，比如“某某是某个理论的中文吗”。

- 只用设置里“问 AI 模型”名单中走 API Key 的模型（engine 为 openai，含 Anthropic、Gemini、OpenAI 等各家 API），
  token 花在使用者自己的 API 额度上，不经过 Claude Code / Codex 这类订阅制命令列工具。
- 文献库里各篇论文的术语表（paper.json 的 glossary）中，和问题对得上的条目会一起交给模型，
  让回答沿用使用者已经在用的译名。
- 对话记录存在资料目录的 ask.json（测试用的临时文献库存在文献库里），最多保留 MAX_THREADS 个对话。
"""
from __future__ import annotations

import re
import threading
from uuid import uuid4

from . import chat_models, config, usage
from .i18n import tr
from .store import now_iso, read_json, write_json_atomic

MAX_THREADS = 40
MAX_MESSAGES = 60
HISTORY = 10          # 带上最近几轮对话
GLOSSARY_HITS = 24    # 最多带几条术语
_lock = threading.Lock()


def _path():
    return config.library_dir() / ".ask.json" if config.temp_library() else config.HOME / "ask.json"


def _load() -> dict:
    data = read_json(_path(), {}) or {}
    threads = data.get("threads") if isinstance(data.get("threads"), list) else []
    return {"threads": [t for t in threads if isinstance(t, dict) and t.get("id")]}


def threads() -> list[dict]:
    return sorted(_load()["threads"], key=lambda t: t.get("updated", ""), reverse=True)


def get(tid: str | None) -> dict | None:
    return next((t for t in threads() if t["id"] == tid), None) if tid else None


def delete(tid: str) -> list[dict]:
    with _lock:
        data = _load()
        data["threads"] = [t for t in data["threads"] if t.get("id") != tid]
        write_json_atomic(_path(), data)
    return threads()


def append(tid: str, question: str, answer: str, model_id: str, model_name: str, used: dict | None = None) -> dict:
    stamp = now_iso()
    msg = {"id": "m" + uuid4().hex, "role": "assistant", "content": answer, "model": model_name, "at": stamp}
    if used and used.get("calls"):
        msg["usage"] = used
    with _lock:
        data = _load()
        t = next((x for x in data["threads"] if x["id"] == tid), None)
        if not t:
            title = re.sub(r"\s+", " ", question).strip()[:40]
            t = {"id": tid, "title": title, "model": model_id, "created": stamp, "messages": []}
            data["threads"].append(t)
        t["messages"] = (t.get("messages") or []) + [{"role": "user", "content": question, "at": stamp}, msg]
        t["messages"] = t["messages"][-MAX_MESSAGES:]
        t["model"], t["updated"] = model_id, stamp
        data["threads"] = sorted(data["threads"], key=lambda x: x.get("updated", ""), reverse=True)[:MAX_THREADS]
        write_json_atomic(_path(), data)
    return msg


def new_id() -> str:
    return "a" + uuid4().hex


# ---------- 模型：只列走 API 的 ----------
def models(cfg: dict | None = None) -> dict:
    cfg = cfg or config.load()
    listing = chat_models.listing(cfg)
    api = [m for m in listing["models"] if m.get("engine") == "openai"]
    keep = ("id", "label", "source", "ready", "hint", "detail")
    out = [{k: m.get(k) for k in keep} for m in api]
    ready = [m for m in out if m["ready"]]
    default = listing.get("default")
    if default not in {m["id"] for m in ready}:
        default = ready[0]["id"] if ready else (out[0]["id"] if out else "")
    return {"models": out, "default": default}


def engine_cfg(cfg: dict, model_id: str | None) -> tuple[dict, dict]:
    listing = models(cfg)
    want = model_id or listing["default"]
    if not want or want not in {m["id"] for m in listing["models"]}:
        raise ValueError(tr("请先在设置 → 模型里加一个用 API Key 的模型，问题会用你自己的 API 额度回答"))
    return chat_models.engine_cfg(cfg, want)


# ---------- 术语：文献库里已有的译名 ----------
def glossary_hits(lib, text: str, limit: int = GLOSSARY_HITS) -> list[dict]:
    """文献库各篇术语表里，英文或译名出现在问题里的条目（同一个英文只留一条，记下出自哪几篇）。"""
    folded = text.casefold()
    found: dict[str, dict] = {}
    try:
        items = lib.list()
    except Exception:  # noqa: BLE001 —— 文献库读不了也照样回答
        return []
    for item in items:
        ws = lib.ws(item.get("id", ""))
        if not ws:
            continue
        try:
            paper = ws.load("paper") or {}
        except Exception:  # noqa: BLE001
            continue
        title = (paper.get("meta") or {}).get("short_zh") or (paper.get("meta") or {}).get("title_en") or item.get("id", "")
        for g in paper.get("glossary") or []:
            if not isinstance(g, dict):
                continue
            en, zh = str(g.get("en") or "").strip(), str(g.get("zh") or "").strip()
            if not en or not zh:
                continue
            hit = (len(en) >= 3 and en.casefold() in folded) or (len(zh) >= 2 and zh in text)
            if not hit:
                continue
            entry = found.setdefault(en.casefold(), {"en": en, "zh": zh, "papers": []})
            if title not in entry["papers"]:
                entry["papers"].append(title)
            if len(found) >= limit:
                return list(found.values())
    return list(found.values())


# ---------- 提示词 ----------
INSTRUCTIONS = (  # i18n-ok: 给模型的提示词
    "你是一位嚴謹的學術研究助理，對象是商管、社會科學領域的博士生。請用繁體中文（臺灣學術用語）回答，"  # i18n-ok: 给模型的提示词
    "保留必要的英文原文術語。\n"  # i18n-ok: 给模型的提示词
    "- 問到術語或理論的中文譯名時：先直接回答是或不是，再給出臺灣學界常用譯名、英文原文、"  # i18n-ok: 给模型的提示词
    "它屬於哪個理論或構面（例如計畫行為理論 TPB 的態度、主觀規範、知覺行為控制）、提出者與年代，"  # i18n-ok: 给模型的提示词
    "以及容易混淆的相近概念。不同譯名並存時一併列出並說明哪個較常見。\n"  # i18n-ok: 给模型的提示词
    "- 不確定的地方明說不確定，不要捏造文獻、作者、年代或期刊；提到文獻時只寫你有把握的，並提醒使用者自行查證。\n"  # i18n-ok: 给模型的提示词
    "- 回答精簡，先給結論再補充；需要時可用短清單或表格。"  # i18n-ok: 给模型的提示词
)


def prompt(messages: list[dict], hits: list[dict]) -> str:
    parts = [INSTRUCTIONS]
    if hits:
        rows = "\n".join(f"- {h['en']} → {h['zh']}（出自：{'、'.join(h['papers'][:3])}）" for h in hits)  # i18n-ok
        parts.append("使用者文獻庫裡已在用的譯名（回答時優先沿用，若你認為譯名不妥可說明）：\n" + rows)  # i18n-ok
    convo = messages[-(HISTORY * 2 + 1):]
    lines = [("使用者：" if m["role"] == "user" else "助理：") + m["content"] for m in convo]  # i18n-ok
    parts.append("對話：\n" + "\n\n".join(lines) + "\n\n助理：")  # i18n-ok
    return "\n\n".join(parts)


def stream_answer(lib, body: dict, send, cancel: threading.Event):
    """一行一个 JSON：{"model", "thread", "glossary"}、{"t": 片段}…、{"done", "id"} 或 {"error"}。"""
    from . import chat
    text = str(body.get("text") or "").strip()
    if not text:
        raise ValueError(tr("问题是空的"))
    if len(text) > 4000:
        raise ValueError(tr("问题太长了，请缩短到 4000 字以内"))
    cfg = config.load()
    ecfg, m = engine_cfg(cfg, body.get("model"))
    thread = get(body.get("thread"))
    tid = thread["id"] if thread else new_id()
    past = [{"role": x["role"], "content": x["content"]} for x in (thread or {}).get("messages", [])]
    hits = glossary_hits(lib, text) if body.get("use_glossary", True) else []
    label = chat_models.label(m)
    meter = usage.Meter(ecfg["engine"])
    send({"model": label, "thread": tid, "glossary": hits})
    pieces: list[str] = []
    try:
        for piece in chat.stream(ecfg, prompt(past + [{"role": "user", "content": text}], hits), config.HOME, cancel, None, meter):
            pieces.append(piece)
            send({"t": piece})
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        cancel.set()
        if pieces:
            append(tid, text, "".join(pieces) + "\n\n" + tr("（已停止）"), m["id"], label, meter.snapshot())
        return
    msg = append(tid, text, "".join(pieces), m["id"], label, meter.snapshot())
    send({"done": True, "id": msg["id"], "usage": msg.get("usage")})

