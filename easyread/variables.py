"""研究变数标示：请模型读整篇论文，列出自变数、依变数、中介、调节、控制变数，阅读页依角色上色。

存进 paper.json 的 variables = {"items": [{"role", "en", "zh", "abbr", "terms": [...]}], "model", "at"}。
terms 是这个变数在原文和译文里会出现的各种写法（全名、缩写、中文、简称），阅读页用来在正文里找出来标色；
只标正文，不改动内容（用 CSS Highlight，不包标签），所以 PDF 逐字跟随、划线、笔记都不受影响。
"""
from __future__ import annotations

import copy
import re
import threading
import time

from . import engines, langs
from .i18n import tr

ROLES = ("iv", "dv", "med", "mod", "ctrl")
_ALIAS = {"independent": "iv", "x": "iv", "predictor": "iv", "dependent": "dv", "outcome": "dv", "y": "dv",
          "mediator": "med", "mediating": "med", "moderator": "mod", "moderating": "mod", "control": "ctrl", "covariate": "ctrl"}
MAX_VARS = 40
MAX_CHARS = 60000  # 送给模型的原文上限（约 1.5 万 token）；超过时取前面的部分（摘要、文献、假设、方法、结果通常都在这里）

_busy: set[str] = set()
_lock = threading.Lock()


def _role(value) -> str:
    text = str(value or "").strip().lower()
    if text in ROLES:
        return text
    for key, role in _ALIAS.items():
        if text.startswith(key):
            return role
    return ""


def normalize(raw) -> list[dict]:
    """模型给的变数整理成固定格式：角色认不得的、没名字的丢掉；terms 去重，太短的（1 个字）丢掉免得满篇乱标。"""
    if isinstance(raw, dict):
        raw = raw.get("variables")
    if not isinstance(raw, list):
        return []
    out, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        role = _role(item.get("role"))
        en = str(item.get("en") or "").strip()[:120]
        zh = str(item.get("zh") or "").strip()[:80]
        abbr = str(item.get("abbr") or "").strip()[:20]
        if not role or not (en or zh) or (role, en.casefold(), zh) in seen:
            continue
        seen.add((role, en.casefold(), zh))
        terms = []
        for t in [en, zh, abbr, *(item.get("terms") or [])]:
            t = re.sub(r"\s+", " ", str(t or "")).strip()[:80]
            if len(t) >= 2 and t.casefold() not in {x.casefold() for x in terms}:
                terms.append(t)
        out.append({"role": role, "en": en, "zh": zh, "abbr": abbr, "terms": terms[:12]})
        if len(out) >= MAX_VARS:
            break
    return out


def _text(paper: dict) -> str:
    """整篇的原文（标题、段落、列表、表题图题），按顺序；没有原文的块用译文。"""
    parts = []
    for b in paper.get("blocks", []):
        t = b.get("type")
        if t == "heading":
            parts.append("\n## " + (b.get("en") or b.get("zh") or ""))
        elif t in ("para", "list"):
            text = b.get("en") or b.get("zh") or " ".join(i.get("en") or i.get("zh") or "" for i in b.get("items") or [])
            parts.append(str(text).replace("‖", ""))
        elif t in ("table", "figure"):
            parts.append(b.get("caption_en") or b.get("caption_zh") or "")
    text = "\n".join(p for p in parts if p)
    return text[:MAX_CHARS]


def prompt(paper: dict, target: str) -> str:
    name = langs.prompt_name(target)
    meta = paper.get("meta") or {}
    return (  # i18n-ok: 给模型的提示词
        f"下面是一篇學術論文的原文（題目：{meta.get('title_en') or meta.get('title_zh') or ''}）。"  # i18n-ok
        "請找出這篇研究的研究變數，標明每個變數的角色：\n"  # i18n-ok
        "- iv：自變數（解釋變數、前因、預測變數）\n- dv：依變數（結果變數、被解釋變數）\n"  # i18n-ok
        "- med：中介變數\n- mod：調節變數（干擾變數）\n- ctrl：控制變數\n"  # i18n-ok
        "只列作者在研究架構、假設、模型或迴歸式裡真的使用的變數；同一個變數在不同假設裡角色不同時，以研究架構圖或主要模型為準。"  # i18n-ok
        "不是實證研究、沒有這類變數時，回傳空的 variables。\n"  # i18n-ok
        f"每個變數給：role、en（原文全名）、zh（{name}譯名，與學界常用譯法一致）、abbr（文中用的縮寫，沒有就留空）、"  # i18n-ok
        "terms（這個變數在原文和譯文裡會出現的其他寫法，例如單數複數、簡稱、構面名稱；不要放太籠統、會誤標其他東西的詞）。\n"  # i18n-ok
        "只輸出一個 JSON 物件，不要任何別的文字：\n"  # i18n-ok
        '{"variables": [{"role": "iv", "en": "Perceived behavioral control", "zh": "知覺行為控制", "abbr": "PBC", "terms": ["behavioral control"]}, '  # i18n-ok
        '{"role": "dv", "en": "Adoption intention", "zh": "採用意願", "abbr": "", "terms": ["intention to adopt", "採用意圖"]}]}\n\n'  # i18n-ok
        "===== 論文原文 =====\n" + _text(paper)  # i18n-ok
    )


def extract(ws, cfg: dict, cancel=None, meter=None) -> dict:
    """请模型找出研究变数，写回 paper.json 的 variables。返回 variables。"""
    key = str(ws.root)
    with _lock:
        if key in _busy:
            raise ValueError(tr("正在找这篇的研究变数"))
        _busy.add(key)
    try:
        paper = ws.load("paper") or {}
        if not paper.get("blocks"):
            raise ValueError(tr("这篇还没有内容"))
        target = langs.of_paper(paper.get("meta"))
        ecfg = engines.for_translation(copy.deepcopy(cfg))
        text = engines.run(ecfg, prompt(paper, target), ws.root, None, cancel, meter, json_mode=True)
        items = normalize(engines.parse_json(text))
        if target == "zh-TW":
            from .traditional import convert
            for v in items:
                v["zh"] = convert(v["zh"])
                v["terms"] = list(dict.fromkeys(convert(t) if re.search(r"[一-鿿]", t) else t for t in v["terms"]))  # i18n-ok: 比对汉字
        result = {"items": items, "model": engines.engine_name(ecfg.get("engine")), "at": time.strftime("%Y-%m-%dT%H:%M:%S")}

        def apply(p):
            p["variables"] = result
            return p
        ws.update("paper", apply)
        return result
    finally:
        with _lock:
            _busy.discard(key)
