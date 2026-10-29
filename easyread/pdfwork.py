"""PDF 相关的机械活：渲染原页、抽文字和字符坐标、裁图、给译文段落定位原页区域。

这里不做任何翻译，也不调用模型。
"""
from __future__ import annotations

import json
import re
import threading
import unicodedata
from contextlib import closing, contextmanager
from functools import lru_cache
from pathlib import Path
from statistics import median

from .store import write_json_atomic

# PDFium is not thread-safe, even when threads open separate documents.
# Keep native handles and their cleanup inside the same process-wide lock.
_PDFIUM_LOCK = threading.RLock()
_LAYOUT_LOCK = threading.RLock()


@contextmanager
def open_pdf(pdf: Path):
    """所有 PDFium 调用与资源释放共用一把锁，包括操作不同文档的线程。"""
    import pypdfium2 as pdfium
    with _PDFIUM_LOCK, closing(pdfium.PdfDocument(str(pdf))) as doc:
        yield doc


def render_pages(pdf: Path, out_dir: Path, scale: float = 2.4, quality: int = 84) -> list[dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    pages = []
    with open_pdf(pdf) as doc:
        for i in range(len(doc)):
            with closing(doc[i]) as page, closing(page.render(scale=scale)) as bitmap:
                w, h = page.get_size()
                with bitmap.to_pil() as raw, raw.convert("RGB") as img:
                    name = f"page-{i + 1:03d}.webp"
                    img.save(out_dir / name, "WEBP", quality=quality, method=5)
                pages.append({"n": i + 1, "w": round(w, 2), "h": round(h, 2), "img": f"pages/{name}"})
    return pages


def extract_text(pdf: Path, out_dir: Path) -> int:
    """每页一份 .txt（给 agent 读）和 .chars.json（给定位用，坐标按页宽高归一化）。"""
    from pypdfium2 import raw as pdfium_c

    out_dir.mkdir(parents=True, exist_ok=True)
    with open_pdf(pdf) as doc:
        for i in range(len(doc)):
            with closing(doc[i]) as page, closing(page.get_textpage()) as tp:
                # A tiled PDF can reference the entire source document on every
                # page. Unbounded text includes the off-page content; pdfplumber
                # also builds and retains a full Python layout for every tile.
                # Use one native text page for both outputs and close it eagerly.
                text = tp.get_text_bounded()
                bounds, rotation = page.get_bbox(), page.get_rotation()
                chars = []
                count = tp.count_chars()
                for index in range(count):
                    box = _char_box(tp.get_charbox(index, loose=True), bounds, rotation)
                    if box is None:
                        continue
                    # Indexing get_text_range() is unsafe: its string indices can
                    # differ from PDFium's character indices (generated newlines,
                    # unmapped glyphs, and non-BMP Unicode characters).
                    code = pdfium_c.FPDFText_GetUnicode(tp, index)
                    if 0xD800 <= code <= 0xDBFF and index + 1 < count:
                        low = pdfium_c.FPDFText_GetUnicode(tp, index + 1)
                        if 0xDC00 <= low <= 0xDFFF:
                            code = 0x10000 + ((code - 0xD800) << 10) + low - 0xDC00
                    if not code or code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
                        continue
                    char = chr(code)
                    if char in "\r\n":
                        continue
                    chars.append([char, *box])
                (out_dir / f"page-{i + 1:03d}.txt").write_text(text, encoding="utf-8")
                (out_dir / f"page-{i + 1:03d}.chars.json").write_text(json.dumps(chars, ensure_ascii=False), encoding="utf-8")
        return len(doc)


def _char_box(box, bounds, rotation: int) -> list[float] | None:
    """PDF canvas -> rendered page, respecting CropBox origin and page rotation."""
    l, b, r, t = box
    L, B, R, T = bounds
    if r <= L or l >= R or t <= B or b >= T:
        return None
    x0, y0 = (max(l, L) - L) / (R - L), (T - min(t, T)) / (T - B)
    x1, y1 = (min(r, R) - L) / (R - L), (T - max(b, B)) / (T - B)
    if rotation == 90:
        x0, y0, x1, y1 = 1 - y1, x0, 1 - y0, x1
    elif rotation == 180:
        x0, y0, x1, y1 = 1 - x1, 1 - y1, 1 - x0, 1 - y0
    elif rotation == 270:
        x0, y0, x1, y1 = y0, 1 - x1, y1, 1 - x0
    return [round(v, 4) for v in (x0, y0, x1, y1)]


def crop(root: Path, page: int, box: list[float], out_name: str, scale: float = 3.0, pdf: Path | None = None) -> str:
    """box 是按页宽高归一化的 [x0, y0, x1, y1]；输出到 figures/，返回相对路径。pdf：连结的原 PDF（默认 source.pdf）。"""
    with open_pdf(pdf or root / "source.pdf") as doc:
        with closing(doc[page - 1]) as pdf_page, closing(pdf_page.render(scale=scale)) as bitmap:
            with bitmap.to_pil() as raw, raw.convert("RGB") as img:
                W, H = img.size
                x0, y0, x1, y1 = box
                with img.crop((int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H))) as part:
                    (root / "figures").mkdir(exist_ok=True)
                    rel = f"figures/{out_name}.webp"
                    part.save(root / rel, "WEBP", quality=90)
    return rel


# ---------- 定位：译文段落 -> 原页区域 ----------

_MATH = re.compile(r"\$[^$]*\$")
_ALNUM = re.compile(r"[a-z0-9]")
LOCATE_VERSION = "9"  # 从上一页接过来的段落也找得到；每句（snts）、每个英文词（words）记下原页上的框；旧论文打开时重算。


def _norm(s: str) -> str:
    return "".join(_ALNUM.findall(unicodedata.normalize("NFKC", s).lower()))


def _page_stream(extract_dir: Path, n: int):
    path = extract_dir / f"page-{n:03d}.chars.json"
    if not path.exists():
        return None
    chars = json.loads(path.read_text(encoding="utf-8"))
    text, idx = [], []
    for k, c in enumerate(chars):
        for t in _norm(c[0]):  # 连字 ﬁ/ﬂ 会展开成两个字母，指向同一个字符框
            text.append(t)
            idx.append(k)
    return "".join(text), idx, chars


def _anchors(en: str) -> tuple[str, str]:
    plain_parts = [p for p in _MATH.split(en) if _norm(p)]
    if not plain_parts:
        return "", ""
    head = _norm(plain_parts[0])[:28]
    tail = _norm(plain_parts[-1])[-28:]
    return head, tail


def _box(chars, idx, a: int, b: int):
    sel = [chars[idx[k]] for k in range(a, min(b, len(idx) - 1) + 1)]
    return [min(c[1] for c in sel), min(c[2] for c in sel), max(c[3] for c in sel), max(c[4] for c in sel)]


def _bounds(boxes: list[list[float]]) -> list[float]:
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _boxes(chars, idx, a: int, b: int) -> list[list[float]]:
    """保留栏间空白：横向不相连的字符分组各有一个框，而不是取整段的外接框。"""
    selected = [chars[i][1:5] for i in set(idx[a:min(b + 1, len(idx))])]
    selected = [box for box in selected if box[2] > box[0] and box[3] > box[1]]
    if not selected:
        return [_box(chars, idx, a, b)]
    gap = max(0.008, median(box[2] - box[0] for box in selected) * 2.5)
    boxes = []
    for box in sorted(selected, key=lambda box: box[0]):
        if not boxes or box[0] > boxes[-1][2] + gap:
            boxes.append(list(box))
        else:
            boxes[-1] = _bounds([boxes[-1], box])
    return boxes


def _line_boxes(chars, idx, a: int, b: int) -> list[list[float]]:
    """一句话在原页上的逐行框：同一行（纵向重叠）、同一栏（横向相连）的字符并成一个框，
    这样高亮只落在这句话的字上，不会把同一行前后别的句子也框进去。"""
    seen, rows = set(), []
    for k in range(a, min(b + 1, len(idx))):
        i = idx[k]
        if i in seen:
            continue
        seen.add(i)
        box = chars[i][1:5]
        if not (box[2] > box[0] and box[3] > box[1]):
            continue
        last = rows[-1] if rows else None
        height = (box[3] - box[1]) or 0.01
        same_line = last and abs((last[1] + last[3]) / 2 - (box[1] + box[3]) / 2) < height * 0.6 \
            and box[0] >= last[0] - 0.01 and box[0] - last[2] < 0.03
        if same_line:  # 就地放大（这里每个字都会走一次，别为它建新的 list）
            if box[0] < last[0]: last[0] = box[0]
            if box[1] < last[1]: last[1] = box[1]
            if box[2] > last[2]: last[2] = box[2]
            if box[3] > last[3]: last[3] = box[3]
        else:
            rows.append(list(box))
    return [[round(v, 4) for v in r] for r in rows]


def _utf16_slice(text: str, a: int, b: int) -> str:
    """sents 里的位置是 JS 字符串位置（UTF-16 码元），按同样的单位切。"""
    raw = text.encode("utf-16-le")
    return raw[a * 2:b * 2].decode("utf-16-le", errors="ignore")


def _sentence_spans(en: str, sents) -> list[str]:
    if not isinstance(sents, list) or len(sents) < 2:
        return []
    out, prev = [], 0
    for row in sents:
        if not isinstance(row, list) or len(row) < 1:
            return []
        out.append(_utf16_slice(en, prev, row[0]))
        prev = row[0]
    return out


def _sentence_boxes(text: str, idx, chars, a: int, end: int, en: str, sents) -> list | None:
    """段落里每一句在原页上的逐行框：按句子开头的字依次往后找，下一句的开头就是这一句的结尾。
    找不到的句子记 None（前端就退回整段高亮）。"""
    spans = _sentence_spans(en, sents)
    if not spans:
        return None
    starts, pos = [], a
    for span in spans:
        norm = _norm(_MATH.sub(" ", span))
        head = norm[:16]
        hit = text.find(head, pos, end + 1) if len(head) >= 4 else -1
        starts.append(hit)
        if hit >= 0:
            pos = hit + max(1, len(head))
    if starts and starts[0] < 0 and (len(starts) == 1 or starts[1] < 0 or starts[1] > a):
        starts[0] = a  # 第一句的开头在上一页：这页上这段从哪里开始，第一句就从哪里开始
    out = []
    for i, start in enumerate(starts):
        if start < 0:
            out.append(None)
            continue
        nxt = next((x for x in starts[i + 1:] if x > start), end + 1)
        out.append(_line_boxes(chars, idx, start, nxt - 1) or None)
    return out if any(out) else None


_WORD = re.compile(r"\S+")


def _align(plain: str, seg: str, offset: int) -> list[int]:
    """原文（只留英数字）每个字对到原页文字里的位置，对不上的是 -1。
    两边几乎一样（只差公式、页眉、连字号），所以逐字往前走；一对不上就用接下来 8 个字在附近重新找回位置。
    比 difflib 快很多（翻译时每批都要重算整篇）。"""
    out = [-1] * len(plain)
    i = j = 0
    n, m = len(plain), len(seg)
    while i < n and j < m:
        if plain[i] == seg[j]:
            out[i] = offset + j
            i += 1
            j += 1
            continue
        probe = plain[i:i + 8]
        hit = seg.find(probe, j, j + 160) if len(probe) == 8 else -1
        if hit >= 0:
            j = hit  # 原页多出来的字（页眉、公式符号）：跳过
            continue
        i += 1  # 原文多出来的字（公式、上一页那截）：这个字不框
    return out


def _word_boxes(text: str, idx, chars, a: int, end: int, en: str) -> list:
    """英文原文每个词在原页上的框：[[词开头, 词结尾, x0, y0, x1, y1], …]。
    词的位置用“去掉公式后只留英数字”的累计位置表示（页面上用同样的算法从滑鼠位置换算），
    原页这一段文字和原文逐字对齐（difflib），对不上的字（公式、页眉、上一页的那截）就跳过。
    一个词断在两行（连字号）时有两个框，开头结尾相同。"""
    plain_tokens = [(_norm(m.group(0))) for m in _WORD.finditer(_MATH.sub(" ", en))]
    plain = "".join(plain_tokens)
    seg_end = min(len(text), end + 1 + 40)
    seg = text[a:seg_end]
    if not plain or not seg:
        return []
    page_of = _align(plain, seg, a)
    out, pos = [], 0
    for tok in plain_tokens:
        ns, ne = pos, pos + len(tok)
        pos = ne
        hits = [page_of[k] for k in range(ns, ne) if page_of[k] >= 0]
        if not tok or len(hits) * 2 < len(tok):  # 一半以上的字对不上：不框，免得框错地方
            continue
        for box in _line_boxes(chars, idx, min(hits), max(hits)):
            out.append([ns, ne] + box)
    return out


def _words(block: dict, text: str, idx, chars, a: int, end: int) -> dict:
    """{键: 每个英文词的框}；键和 snts 一样（段落是块 id，列表项是 id#序号）。"""
    out = {}
    if block.get("type") == "para" and block.get("en"):
        got = _word_boxes(text, idx, chars, a, end, block["en"])
        if got:
            out[block["id"]] = got
    elif block.get("type") == "list":
        pos = a
        for i, item in enumerate(block.get("items") or []):
            if not isinstance(item, dict) or not item.get("en"):
                continue
            start = _find_start(text[: end + 1], _norm(_MATH.sub(" ", item["en"])), [_anchors(item["en"])[0][:16]], pos)
            if start < 0:
                continue
            nxt = len(_norm(_MATH.sub(" ", item["en"])))
            got = _word_boxes(text, idx, chars, start, min(end, start + nxt + 20), item["en"])
            if got:
                out[f"{block['id']}#{i}"] = got
            pos = start + 1
    return out


def _snts(block: dict, text: str, idx, chars, a: int, end: int) -> dict:
    """{键: [每句的逐行框或 None]}；段落的键是块 id，列表项是 id#序号（和页面上的 data-key 一致）。"""
    out = {}
    if block.get("type") == "para" and block.get("en"):
        got = _sentence_boxes(text, idx, chars, a, end, block["en"], block.get("sents"))
        if got:
            out[block["id"]] = got
    elif block.get("type") == "list":
        pos = a
        for i, item in enumerate(block.get("items") or []):
            if not isinstance(item, dict) or not item.get("en"):
                continue
            head = _anchors(item["en"])[0][:16]
            start = text.find(head, pos, end + 1) if head else -1
            if start < 0:
                continue
            got = _sentence_boxes(text, idx, chars, start, end, item["en"], item.get("sents"))
            if got:
                out[f"{block['id']}#{i}"] = got
            pos = start + 1
    return out


def _find_start(text: str, plain: str, heads: list[str], since: int = 0) -> int:
    return _find_start_skip(text, plain, heads, since)[0]


def _find_start_skip(text: str, plain: str, heads: list[str], since: int = 0) -> tuple[int, int]:
    """段落开头在这页文字里的位置；找不到返回 -1。
    先用开头几个字找；找不到时（段落是从上一页接过来的，开头那几个字在上一页；或模型把跨页的字重复了一次），
    改用段落里往后的片段找，对上了再往前一个字一个字比对，退到这页上真正的开头。"""
    for h in heads:
        if not h:
            continue
        a = text.find(h, since)
        if a < 0:
            a = text.find(h)
        if a >= 0:
            return a, 0
    if len(plain) < 48:
        return -1, 0
    for o in range(6, min(len(plain) - 28, 480), 6):
        probe = plain[o:o + 28]
        a = text.find(probe, since)
        if a < 0:
            a = text.find(probe)
        if a < 0:
            continue
        k = 0
        while a - k - 1 >= 0 and o - k - 1 >= 0 and text[a - k - 1] == plain[o - k - 1]:
            k += 1
        return a - k, o - k
    return -1, 0


def block_english(block: dict) -> str:
    if block.get("type") == "list":
        return " ".join(it.get("en", "") for it in block.get("items", []))
    if block.get("type") in ("table", "figure"):
        return block.get("caption_en", "")
    return block.get("en", "")


def locate(root: Path, detail: bool = True) -> dict:
    """detail=False：只算段落框（翻译时每批都要重算整篇，求快）；逐句、逐字的框等整篇译完或打开阅读页时再补。"""
    with _LAYOUT_LOCK:
        return _locate(root, detail)


def _locate(root: Path, detail: bool = True) -> dict:
    paper = json.loads((root / "paper.json").read_text(encoding="utf-8"))
    extract_dir = root / "extract"
    # Blocks may arrive out of page order during parallel translation. Keep only
    # the current/next page streams instead of retaining a whole book's chars.
    @lru_cache(maxsize=2)
    def stream(n):
        return _page_stream(extract_dir, n)

    # 往远处的页找时只要每页的文字（几千字，很小），对上了才载入那页的字符框
    @lru_cache(maxsize=None)
    def page_text(n):
        st = _page_stream(extract_dir, n)
        return st[0] if st else ""

    total = len(list(extract_dir.glob("page-*.chars.json")))
    layout: dict[str, dict] = {}
    cursor: dict[int, int] = {}
    for block in paper.get("blocks", []):
        try:
            _locate_block(block, layout, cursor, stream, page_text, total, detail)
        except Exception:  # noqa: BLE001 —— 一段对不上（格式怪、文字层异常）不要连累整篇都没有原页框
            from .log import log
            log.exception("定位段落失败 %s %s", root.name, block.get("id"))
    _extend_captioned(paper.get("blocks", []), layout, root)
    _clamp_overlaps(layout)
    _fill_gaps(paper.get("blocks", []), layout)
    write_json_atomic(root / "layout.json", layout)
    # 只算了段落框时记成 “版本-lite”，打开阅读页（refresh_layout）看到版本不同就会补算逐句、逐字
    (extract_dir / "locate.version").write_text(LOCATE_VERSION if detail else LOCATE_VERSION + "-lite", encoding="utf-8")
    return layout


def _locate_block(block: dict, layout: dict, cursor: dict, stream, page_text, total: int, detail: bool) -> None:
    """一个块在原页上的位置，写进 layout（见 _locate）。"""
    bid, page = block.get("id"), block.get("page")
    if not bid or not page:
        return
    if block.get("box"):
        layout[bid] = {"page": page, "box": block["box"], "src": "manual"}
        return
    head, tail = _anchors(block_english(block))
    if not head:
        return
    heads = [head]
    if block.get("type") == "heading" and block.get("num"):
        heads.insert(0, _anchors(f"{block['num']} {block.get('en', '')}")[0])
    # 模型给的页码偶尔会错（跨页的段落、没认出页眉的页）：先找它说的那页和下一页，
    # 找不到再往前后各页找。远处的页只认够长的开头，免得短句子撞到别处的同样字词。
    plain = _norm(_MATH.sub(" ", block_english(block)))
    near = (page, page + 1)
    far = sorted((n for n in range(1, total + 1) if n not in near), key=lambda n: (abs(n - page), n))
    for pn in near + tuple(far):
        if pn not in near:
            if len(plain) < 20:
                break  # 太短的字在别页很容易撞到一样的，不往远处找
            if _find_start(page_text(pn), plain, [head if len(head) >= 20 else ""]) < 0:
                continue
        st = stream(pn)
        if not st:
            continue
        text, idx, chars = st
        a, skipped = _find_start_skip(text, plain, heads, cursor.get(pn, 0) if pn == page else 0)
        if a < 0:
            continue
        # 段落结尾：同样的结尾字串可能出现好几次（学术文章常重复同一句型），取最接近“开头 + 段落长度”的那一个
        expect = a + len(plain) - skipped - 1
        b, hit = -1, (text.find(tail, a) if tail else -1)
        while hit >= 0:
            if b < 0 or abs(hit + len(tail) - 1 - expect) < abs(b + len(tail) - 1 - expect):
                b = hit
            hit = text.find(tail, hit + 1)
        end = b + len(tail) - 1 if b >= 0 else min(a + len(plain) - skipped, len(idx) - 1)
        boxes = _boxes(chars, idx, a, end)
        layout[bid] = {"page": pn, "box": _bounds(boxes), "src": "text" if b >= 0 else "head"}
        if len(boxes) > 1:
            layout[bid]["boxes"] = boxes
        if block.get("type") in ("figure", "table"):
            layout[bid]["cap"] = _bounds(boxes)  # 题注本身的位置；图的区域之后会往外扩，裁图时要把题注切掉
        if detail:
            snts = _snts(block, text, idx, chars, a, end)
            if snts:
                layout[bid]["snts"] = snts
            words = _words(block, text, idx, chars, a, end)
            if words:
                layout[bid]["words"] = words
        cursor[pn] = end
        break


def refresh_layout(root: Path) -> None:
    """沿用上游的版本标记；并发打开同一篇论文时只重算一次。
    layout.json 还不存在（翻译当时定位出错，或用命令列直接写进的块）但已经有译好的块时，也补算一次。"""
    with _LAYOUT_LOCK:
        marker = root / "extract" / "locate.version"
        if not (root / "paper.json").exists():
            return
        if not any((root / "extract").glob("page-*.chars.json")):
            return
        if (root / "layout.json").exists():
            if marker.exists() and marker.read_text(encoding="utf-8").strip() == LOCATE_VERSION:
                return
        else:
            try:
                blocks = json.loads((root / "paper.json").read_text(encoding="utf-8")).get("blocks") or []
            except (OSError, ValueError):
                return
            if not blocks:
                return
        locate(root)


def _overlap_x(a: list, x0: float, x1: float) -> bool:
    return max(a[0], x0) < min(a[2], x1) - 0.01


def _column(locs: list[dict], box: list) -> tuple[float, float] | None:
    """双栏页上 box 所在那一栏的左右边界；单栏页或 box 本身横跨两栏时返回 None。"""
    left = [l["box"] for l in locs if l["box"][2] <= 0.55]
    right = [l["box"] for l in locs if l["box"][0] >= 0.45]
    if len(left) < 2 or len(right) < 2 or box[2] - box[0] > 0.5:
        return None
    col = right if (box[0] + box[2]) / 2 >= 0.5 else left
    return min(b[0] for b in col), max(b[2] for b in col)


def _page_locs(layout: dict, page: int) -> list[dict]:
    return [{"page": page, "box": box, "src": loc["src"], "_parent": loc}
            for loc in layout.values() if loc["page"] == page
            for box in loc.get("boxes") or [loc["box"]]]


def _extend_captioned(blocks: list[dict], layout: dict, root: Path | None = None):
    """图优先用 PDF 图形边界；表格或无法识别的图按题注所在栏估算。"""
    from .figure_geometry import locate_figures
    visual = locate_figures(root, blocks, layout) if root else {}
    for block in blocks:
        loc = layout.get(block.get("id"))
        if block.get("type") not in ("table", "figure") or not loc or loc.get("src") == "manual":
            continue
        if block["id"] in visual:
            loc["box"] = visual[block["id"]]
            loc.pop("boxes", None)
            loc["src"] = "graphic"
            continue
        x0, y0, x1, y1 = loc["box"]
        others = [l for l in _page_locs(layout, loc["page"]) if l["_parent"] is not loc]
        col = _column(others, loc["box"])
        if col:
            x0, x1 = col
        elif x1 - x0 < 0.45 and abs((x0 + x1) / 2 - 0.5) > 0.1:  # 窄题注偏在一侧：正文绕排的小表/小图
            x0, x1 = max(0.05, x0 - 0.02), min(0.95, x1 + 0.02)
        else:
            x0, x1 = min(x0, 0.15), max(x1, 0.85)
        same_col = [l["box"] for l in others if _overlap_x(l["box"], x0, x1)]
        if block.get("caption_pos", "below") == "below":
            above = [b[3] for b in same_col if b[3] < y0]
            y0 = max(above) + 0.005 if above else 0.08
        else:
            below = [b[1] for b in same_col if b[1] > y1]
            y1 = min(below) - 0.005 if below else 0.92
        loc["box"] = [x0, round(y0, 4), x1, round(y1, 4)]
        loc.pop("boxes", None)  # 图表框要包含图像本身，按题注扩展后用整个区域。
        loc["src"] = "caption"  # 撑过的框旁边常有绕排正文，后面截重叠时不能再截它


def _clamp_overlaps(layout: dict):
    """只匹配到开头的块按长度估了结尾，可能压到同一栏的下一块；截到它的上沿。"""
    by_page = {page: _page_locs(layout, page) for page in {loc["page"] for loc in layout.values()}}
    for locs in by_page.values():
        locs.sort(key=lambda l: l["box"][1])
        for i, cur in enumerate(locs):
            if cur["src"] not in ("head", "text"):
                continue
            nxt = next((l for l in locs[i + 1:] if l["_parent"] is not cur["_parent"]
                        and _overlap_x(l["box"], cur["box"][0], cur["box"][2])
                        and l["box"][1] > cur["box"][1]), None)
            if nxt and cur["box"][3] > nxt["box"][1]:
                cur["box"][3] = round(nxt["box"][1] - 0.002, 4)
    for loc in layout.values():
        if loc.get("boxes"):
            loc["box"] = _bounds(loc["boxes"])


def _fill_gaps(blocks: list[dict], layout: dict):
    """公式这类没有英文可匹配的块：放在同一栏里下一块之上、上方最近一块之下。"""
    for i, block in enumerate(blocks):
        bid = block.get("id")
        if not bid or bid in layout or not block.get("page"):
            continue
        if _norm(block_english(block)):
            continue  # 有英文却没在原页找到：不要猜一个大框（会框住整页，看起来像对上了），宁可不框
        page = block["page"]
        locs = _page_locs(layout, page)
        prev = next((layout[b["id"]] for b in reversed(blocks[:i]) if layout.get(b.get("id"), {}).get("page") == page), None)
        nxt = next((layout[b["id"]] for b in blocks[i + 1:] if layout.get(b.get("id"), {}).get("page") == page), None)
        if prev and prev.get("boxes"):
            prev = {**prev, "box": prev["boxes"][-1]}
        if nxt and nxt.get("boxes"):
            nxt = {**nxt, "box": nxt["boxes"][0]}
        ref = prev or nxt
        col = _column(locs, ref["box"]) if ref else None
        x0, x1 = col if col else (0.12, 0.88)
        if nxt and not _overlap_x(nxt["box"], x0, x1):
            nxt = None  # 下一块在另一栏，不能拿它当下沿
        bottom = nxt["box"][1] if nxt else 0.92
        above = [l["box"][3] for l in locs if _overlap_x(l["box"], x0, x1) and l["box"][3] <= bottom + 0.001]
        top = max(above) if above else 0.08
        if bottom - top < 0.01:
            bottom = top + 0.04
        layout[bid] = {"page": page, "box": [x0, round(top, 4), x1, round(bottom, 4)], "src": "between"}


def engine_image(root: Path, n: int) -> Path:
    """给翻译模型看的原页图（JPEG，模型工具普遍支持），按需生成。"""
    out = root / "extract" / f"page-{n:03d}.jpg"
    with _PDFIUM_LOCK:
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            with open_pdf(root / "source.pdf") as doc:
                with closing(doc[n - 1]) as page, closing(page.render(scale=2.0)) as bitmap:
                    with bitmap.to_pil() as raw, raw.convert("RGB") as img:
                        img.save(out, "JPEG", quality=82)
    return out


def page_variant(root: Path, rel: str, width: int) -> Path | None:
    """原页图的缩小版（原图 2.4 倍渲染、约 1500 像素宽，右侧面板用不着那么大）。生成一次缓存在 pages/w{宽}/。"""
    width = max(400, min(2000, width // 100 * 100))
    src = (root / rel).resolve()
    if not src.is_relative_to((root / "pages").resolve()) or not src.is_file():
        return None
    out = root / "pages" / f"w{width}" / src.name
    if not out.exists():
        from PIL import Image
        out.parent.mkdir(exist_ok=True)
        with Image.open(src) as im:
            if im.width <= width:
                return src
            im.resize((width, round(im.height * width / im.width)), Image.LANCZOS).save(out, "WEBP", quality=80, method=4)
    return out


PANEL_WIDTH = 1000  # 原页面板默认要的宽度（阅读页按面板宽度只会要 1000 或 1600）


def warm_variants(root: Path, width: int = PANEL_WIDTH) -> None:
    """后台把整篇的面板图都先生成好，打开原页面板时不用等。"""
    pages_dir = root / "pages"
    if not pages_dir.exists():
        return
    for src in sorted(pages_dir.glob("page-*.webp")):
        if not (root / "pages" / f"w{width}" / src.name).exists():
            page_variant(root, f"pages/{src.name}", width)


def prepare(root: Path) -> list[dict]:
    """渲染原页 + 抽文字，返回 meta.pages。"""
    pages = render_pages(root / "source.pdf", root / "pages")
    extract_text(root / "source.pdf", root / "extract")
    return pages
