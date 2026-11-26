"""翻译版的图：把图里每个英文标签在图上的位置找出来（ibox，相对截图的 0~1 坐标），阅读页在原图旁边画一张换成中文的图。

位置从哪来：
1. 向量图（文字在 PDF 文字层里）：在原页这张图的范围内找标签的英文字，取那些字的外框——准，不用问模型。
2. 扫描或贴图的图：模型给的位置——翻译时的 pbox（整页坐标，和图的 box 同一套）或“辨识图内文字”时的 box（相对这张截图）。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .log import log

_TEX = re.compile(r"\$([^$]*)\$")


def _plain(text: str) -> str:
    """标签英文 → 比对用的字母数字（拿掉 TeX 记号）。"""
    text = _TEX.sub(lambda m: re.sub(r"\\[a-zA-Z]+|[{}^_\\]", "", m.group(1)), str(text or ""))
    return re.sub(r"[^0-9a-z]", "", text.lower())


def _chars(root: Path, page: int) -> list:
    try:
        return json.loads((root / "extract" / f"page-{page:03d}.chars.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _inside(c, box, pad=0.004) -> bool:
    x = (c[1] + c[3]) / 2
    y = (c[2] + c[4]) / 2
    return box[0] - pad <= x <= box[2] + pad and box[1] - pad <= y <= box[3] + pad


def _relative(b, crop) -> list[float] | None:
    w, h = crop[2] - crop[0], crop[3] - crop[1]
    if w <= 0 or h <= 0:
        return None
    r = [(b[0] - crop[0]) / w, (b[1] - crop[1]) / h, (b[2] - crop[0]) / w, (b[3] - crop[1]) / h]
    r = [round(min(1.0, max(0.0, v)), 4) for v in r]
    return r if r[2] - r[0] > 0.002 and r[3] - r[1] > 0.002 else None


def _valid(box) -> bool:
    return isinstance(box, (list, tuple)) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box) and 0 <= box[0] < box[2] <= 1.001 and 0 <= box[1] < box[3] <= 1.001


def vector_boxes(chars: list, crop, labels: list[dict]) -> dict[int, list[float]]:
    """向量图：在截图范围内的字里找每个标签的英文，返回 {标签序号: 整页坐标外框}。同一串字出现多次时依序取用。"""
    inside = [c for c in chars if len(c) >= 5 and _inside(c, crop)]
    seq, pos = "", []
    for i, c in enumerate(inside):
        for ch in str(c[0]).lower():
            if ch.isalnum():
                seq += ch
                pos.append(i)
    out, used = {}, set()
    for k, lab in enumerate(labels):
        key = _plain(lab.get("en"))
        if len(key) < 2:
            continue
        start = 0
        while True:
            at = seq.find(key, start)
            if at < 0:
                break
            span = range(at, at + len(key))
            if not any(i in used for i in span):
                used.update(span)
                cs = [inside[pos[i]] for i in span]
                out[k] = [min(c[1] for c in cs), min(c[2] for c in cs), max(c[3] for c in cs), max(c[4] for c in cs)]
                break
            start = at + 1
    return out


def place(root: Path, block: dict, crop) -> bool:
    """替这张图的标签补上 ibox。有改动就回 True。crop 是截图在原页上的范围（整页 0~1 坐标）。"""
    labels = block.get("image_labels") or []
    if not labels:
        return False
    on_page = _valid(crop)  # 不知道截图在原页的哪里时，只能用模型给的相对位置
    changed = False
    try:
        found = vector_boxes(_chars(root, int(block.get("page") or 0)), crop, labels) if on_page else {}
    except Exception:  # noqa: BLE001 —— 找不到就算了，不影响阅读
        log.exception("找图内文字位置失败 %s %s", root, block.get("id"))
        found = {}
    for k, lab in enumerate(labels):
        box = None
        if k in found:
            box = _relative(found[k], crop)
        elif on_page and _valid(lab.get("pbox")):
            box = _relative(lab["pbox"], crop)
        elif _valid(lab.get("box")):
            box = [round(float(v), 4) for v in lab["box"]]
        if box and lab.get("ibox") != box:
            lab["ibox"] = box
            changed = True
    return changed


def crop_of(block: dict, layout: dict) -> list | None:
    """这张图的截图在原页上的范围：截图时记下的 crop，或按定位框推回来。"""
    if _valid(block.get("crop")):
        return block["crop"]
    loc = (layout or {}).get(block.get("id")) or {}
    if loc.get("box") and loc.get("page") == block.get("page"):
        from .figures import _display_box
        try:
            return list(_display_box(loc["box"], loc, layout, loc["page"]) or loc["box"])
        except Exception:  # noqa: BLE001
            return loc["box"]
    return block.get("box") if _valid(block.get("box")) else None


def refresh(ws) -> int:
    """旧论文：有图内文字、但还没有位置的图，补算位置（打开阅读页时跑）。返回补了几张。"""
    paper = ws.load("paper") or {}
    todo = [b for b in paper.get("blocks", []) if b.get("type") == "figure" and b.get("image_labels")
            and any("ibox" not in lab for lab in b["image_labels"])]
    if not todo:
        return 0
    layout = ws.load("layout") or {}

    def apply(p):
        n = 0
        for b in p.get("blocks", []):
            if b.get("type") == "figure" and b.get("image_labels") and any("ibox" not in lab for lab in b["image_labels"]):
                n += place(ws.root, b, crop_of(b, layout))
        return n
    return ws.update("paper", apply)
