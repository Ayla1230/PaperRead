"""图块截图。两条路：

- 翻译 / 只读原文整理时，模型给了图本身的裁剪框 box：等块 id 在合并锁里最终去重之后，
  prepare_figures 按 box 截图（normalize_figure 只整理字段，不截图）。
- 模型没给框、或是旧论文：打开阅读页时 fill_later 按原页定位（layout.json）补截或更新自动截图。

截图文件名带上页码、框和 PDF 文件身份的哈希（figures/crop-<页>-<哈希>.webp）：
重译改了框就换新文件，不会沿用旧图或浏览器缓存，同 id 的块在别的页上也不会撞到同一张。
"""
from __future__ import annotations

import hashlib
import json
import math
import threading

from . import pdfwork
from .log import log

_running: set[str] = set()


def figure_box(value) -> list[float] | None:
    """归一化 [x0, y0, x1, y1]；不是有限数、反了或太小都算无效。"""
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        coords = [float(x) for x in value]
    except (TypeError, ValueError, OverflowError):
        return None
    if not all(math.isfinite(x) for x in coords):
        return None
    box = [round(max(0.0, min(1.0, x)), 4) for x in coords]
    if box[2] - box[0] < .02 or box[3] - box[1] < .02:
        return None
    return box


def _source(root):
    """裁图用的来源：复制进文献库的 source.pdf，或“连结既有 PDF”时记在 paper.json 里的原路径；
    都没有时用匯入時已渲染好的原页图（pages/page-NNN.webp）。返回 (类型, 路径)。"""
    pdf = root / "source.pdf"
    if pdf.is_file():
        return "pdf", pdf
    try:
        meta = (json.loads((root / "paper.json").read_text(encoding="utf-8")) or {}).get("meta") or {}
    except (OSError, ValueError):
        meta = {}
    linked = meta.get("source_pdf_path")
    if linked:
        from pathlib import Path
        path = Path(linked)
        if path.is_absolute() and path.is_file():
            return "pdf", path
    return "image", None


def _page_image(root, page: int):
    path = root / "pages" / f"page-{page:03d}.webp"
    return path if path.is_file() else None


def _crop_path(root, page: int, box: list[float]) -> str:
    kind, path = _source(root)
    if kind == "image":
        path = _page_image(root, page)
        if path is None:
            raise FileNotFoundError(f"no source for page {page}")
    source = path.stat()
    identity = json.dumps([page, box, source.st_size, source.st_mtime_ns])
    name = f"crop-{page}-{hashlib.sha256(identity.encode()).hexdigest()[:20]}"
    return f"figures/{name}.webp"


def _crop_image(root, page: int, box: list[float], rel: str) -> None:
    from PIL import Image
    with Image.open(_page_image(root, page)) as raw, raw.convert("RGB") as img:
        W, H = img.size
        x0, y0, x1, y1 = box
        with img.crop((int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H))) as part:
            (root / "figures").mkdir(exist_ok=True)
            part.save(root / rel, "WEBP", quality=90)


def crop(root, page: int, box: list[float]) -> str:
    """按页码、框和来源身份命名截图，已有同名文件就直接用。返回相对路径。"""
    rel = _crop_path(root, page, box)
    if not (root / rel).is_file():
        kind, path = _source(root)
        if kind == "pdf":
            pdfwork.crop(root, page, box, rel.rsplit("/", 1)[1][:-5], pdf=path)
        else:
            _crop_image(root, page, box, rel)
    return rel


def normalize_figure(block: dict) -> None:
    """整理模型给的图块字段：框无效就去掉，image_text_* 旧写法改成 image_*。不截图。"""
    box = figure_box(block.get("box"))
    if box:
        block["box"] = box
    else:
        block.pop("box", None)
    for lang in ("en", "zh"):
        key = f"image_{lang}"
        value = block.get(key) or block.pop(f"image_text_{lang}", "")
        if value:
            block[key] = str(value).strip()
    if "image_labels" in block:  # 标题、X/Y 轴、图例的中英对照（见 figure_text.py）
        from .figure_text import joined, normalize_labels
        labels = normalize_labels(block.get("image_labels"))
        if labels:
            block["image_labels"] = labels
            block["image_en"] = block.get("image_en") or joined(labels, "en")
            block["image_zh"] = block.get("image_zh") or joined(labels, "zh")
        else:
            block.pop("image_labels", None)


def prepare_figures(root, blocks: list[dict], total_pages: int) -> None:
    """在合并锁里、最后一次 id 去重之后调用：有 box 的图块重新截图。
    截不了（页码不对、框无效、截图失败）就清掉 src 和 box，留给原页入口和 fill_later。没 box 的块不动。"""
    for block in blocks:
        if block.get("type") != "figure" or not block.get("box"):
            continue
        block["src"] = ""
        page, box = block.get("page"), figure_box(block["box"])
        if not box or not isinstance(page, int) or not 1 <= page <= total_pages:
            block.pop("box", None)
            continue
        try:
            block["src"] = crop(root, page, box)
        except Exception:  # noqa: BLE001
            block.pop("box", None)
            log.exception("截图失败 %s 第 %s 页", block.get("id"), page)


def _display_box(box: list[float], loc: dict, layout: dict, page: int) -> list[float] | None:
    """自动裁图的范围（layout 里图的区域）包含题注，四周还留了一点边，常会带到题注和上下正文的一行字。
    题注在译文里另外显示，正文也在旁边：把这些从图片里切掉。"""
    x0, y0, x1, y1 = box
    cap = figure_box(loc.get("cap")) if loc.get("cap") else None
    if cap and cap[0] < x1 and cap[2] > x0 and cap[1] < y1 and cap[3] > y0:
        if (cap[1] + cap[3]) / 2 > (y0 + y1) / 2:
            y1 = min(y1, cap[1] - 0.004)   # 题注在下面
        else:
            y0 = max(y0, cap[3] + 0.004)   # 题注在上面
    band = (y1 - y0) * 0.15
    for other in layout.values():
        if other is loc or other.get("page") != page:
            continue
        for words in (other.get("words") or {}).values():
            for w in words:
                wx0, wy0, wx1, wy1 = w[2:6]
                if wx1 <= x0 or wx0 >= x1 or wy1 <= y0 or wy0 >= y1:
                    continue
                if wy0 < y0 + band:
                    y0 = max(y0, wy1 + 0.0003)  # 上一段正文的最后一行（只切到字的下缘，不吃进图）
                elif wy1 > y1 - band:
                    y1 = min(y1, wy0 - 0.0003)  # 下一段正文的第一行
    return figure_box([x0, y0, x1, y1])


def _pending(ws):
    """没有截图或自动裁剪范围已变化的图块；保留显式 box 和自定义 src。"""
    layout = ws.load("layout") or {}
    out = []
    for b in (ws.load("paper") or {}).get("blocks", []):
        src = b.get("src", "")
        if b.get("type") != "figure" or src and (b.get("box") or not src.startswith("figures/crop-")):
            continue
        loc = layout.get(b.get("id")) or {}
        box = figure_box(loc.get("box"))
        page = loc.get("page")
        if not box or not isinstance(page, int) or page < 1:
            continue
        box = _display_box(box, loc, layout, page) or box
        x0, y0, x1, y1 = box
        if x1 - x0 < 0.05 or y1 - y0 < 0.03:  # 只匹配到一行题注、没撑开的框截出来没用
            continue
        if src:
            try:
                if src == _crop_path(ws.root, page, box) and (ws.root / src).is_file():
                    continue
            except OSError:
                continue  # PDF 不在时保留已经存在的截图。
        out.append((b, page, box))
    return out


def missing(ws) -> list[tuple[str, int, list[float]]]:
    """需要补截或更新自动截图的图块：[(块 id, 页码, 框)]。"""
    return [(b["id"], page, box) for b, page, box in _pending(ws)]


def fill(ws) -> int:
    """补截或更新自动截图；写回时保留截图期间发生的编辑和重译。"""
    done = {}
    for block, page, box in _pending(ws):
        try:
            done[block["id"]] = (block, crop(ws.root, page, box))
        except Exception:  # noqa: BLE001
            log.exception("截图失败 %s %s", ws.root, block["id"])
    if done:
        def apply(paper):
            count = 0
            for b in paper.get("blocks", []):
                previous, src = done.get(b.get("id"), (None, None))
                if b == previous:
                    b["src"] = src
                    count += 1
            return count
        return ws.update("paper", apply)
    return 0


def fill_later(ws, gate=None) -> None:
    """打开阅读页时在后台补；补完 paper.json 变了，页面轮询到就会重画。"""
    key = str(ws.root)
    if key in _running or not missing(ws):
        return
    if gate:
        gate.begin()
    _running.add(key)

    def run():
        try:
            fill(ws)
        finally:
            _running.discard(key)
            if gate:
                gate.end()
    threading.Thread(target=run, daemon=True).start()
