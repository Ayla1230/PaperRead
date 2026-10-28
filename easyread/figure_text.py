"""图内文字中英对照：标题、X 轴、Y 轴、图例、其他标签，一项一项列出来，原文和译文并排。

- 新翻译的页：翻译提示词请模型直接给 image_labels（见 prompts.py），normalize_labels 整理。
- 旧论文、或图内文字没整理到的：阅读页按“辨识图内文字”，用翻译引擎看裁好的图，补上 image_labels。
存进 paper.json 的图块：image_labels = [{"panel": "a", "role": "title|x|y|legend|label", "en": "…", "zh": "…"}]，
panel 是多张小图时图上印的编号（a、b、g…），单张图留空；阅读页按小图分组显示，
同时更新 image_en / image_zh（合成一行），旧的显示、匯出和繁体转换都还能用。
"""
from __future__ import annotations

import copy
import re
import threading

from . import engines, figures, langs
from .i18n import tr

ROLES = ("title", "x", "y", "legend", "label")
MAX_LABELS = 80  # 化学、生物的图常一张有 6～9 个小图，每个小图又有轴名和图例


def _panel(value) -> str:
    """小图编号统一写法：(g)、G、g) → g；Fig. 3a → a；太长或不像编号的丢掉。"""
    text = str(value or "").strip()
    text = re.sub(r"^(fig(ure)?\.?|圖|图)\s*\d*\s*", "", text, flags=re.I)  # i18n-ok: 比对用的正则
    text = text.strip(" ()（）[]【】.:：").lower()  # i18n-ok: 比对用的字元
    return text if re.fullmatch(r"[a-z]{1,2}|[ivx]{1,4}|\d{1,2}[a-z]?", text) else ""


def normalize_labels(raw) -> list[dict]:
    """模型给的标签整理成固定格式；空的、重复的丢掉，最多 MAX_LABELS 项。"""
    if not isinstance(raw, list):
        return []
    out, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        en = str(item.get("en") or "").strip()[:200]
        zh = str(item.get("zh") or "").strip()[:200]
        role = str(item.get("role") or "label").strip().lower()
        role = {"xaxis": "x", "x-axis": "x", "x_axis": "x", "yaxis": "y", "y-axis": "y", "y_axis": "y", "caption": "title"}.get(role, role)
        if role not in ROLES:
            role = "label"
        if not en and not zh:
            continue
        panel = _panel(item.get("panel"))
        key = (panel, role, en.casefold(), zh)
        if key in seen:
            continue
        seen.add(key)
        out.append({"panel": panel, "role": role, "en": en, "zh": zh} if panel else {"role": role, "en": en, "zh": zh})
        if len(out) >= MAX_LABELS:
            break
    return out


def joined(labels: list[dict], side: str) -> str:
    sep = "; " if side == "en" else "；"  # i18n-ok: 中文分隔符号
    return sep.join(x[side] for x in labels if x.get(side))


def prompt(block: dict, target: str, image_hint: str = "") -> str:
    name = langs.prompt_name(target)
    caption = block.get("caption_en") or block.get("caption_zh") or ""
    return (  # i18n-ok: 给模型的提示词
        f"下面是一篇學術論文裡的一張圖（題注：{caption}）。請只看圖片本身，把圖裡看得到的文字整理出來，並譯成{name}。\n"  # i18n-ok
        "要列出：圖的標題（title）、X 軸名稱（x，含單位）、Y 軸名稱（y，含單位）、圖例裡的每一項（legend）、"  # i18n-ok
        "流程框、節點或其他看得懂的標籤（label）。刻度上的數字、年份、單純的符號不用列。"  # i18n-ok
        "這張圖如果由多張小圖組成（圖上印著 (a)、(b)… 或 A、B…），每一項都要標上 panel（只寫圖上印的編號，例如 a、g），"  # i18n-ok
        "依小圖的順序逐一列出，每張小圖的軸名、圖例各自列；單張圖 panel 留空。"  # i18n-ok
        "數學符號、上下標、單位一律寫成 $TeX$（例如 $j$ (mA cm$^{-2}$)、$Z'$ ($\\Omega$)），en 和 zh 用同樣的寫法。"  # i18n-ok
        "看不清楚或圖裡沒有的就不要列，不要猜，也不要把題注抄進來。專有名詞與縮寫保留原文。\n"  # i18n-ok
        + (image_hint + "\n" if image_hint else "") +
        "只輸出一個 JSON 物件，不要任何別的文字：\n"  # i18n-ok
        '{"labels": [{"panel": "a", "role": "x", "en": "Year", "zh": "年份"}, {"panel": "a", "role": "y", "en": "Cumulative abnormal return (%)", "zh": "累積異常報酬（%）"}, '  # i18n-ok
        '{"panel": "b", "role": "y", "en": "$j$ (mA cm$^{-2}$)", "zh": "電流密度 $j$ (mA cm$^{-2}$)"}]}'  # i18n-ok
    )


_busy: set[str] = set()
_lock = threading.Lock()


def _image(ws, block: dict, layout: dict):
    """这张图的图片：已经裁好的就用它，否则按定位框现裁一张。"""
    src = block.get("src") or ""
    if src and (ws.root / src).is_file():
        return ws.root / src
    loc = layout.get(block.get("id")) or {}
    box = figures.figure_box(block.get("box") or loc.get("box"))
    page = block.get("page") if block.get("box") else loc.get("page")
    if not box or not isinstance(page, int):
        raise ValueError(tr("找不到这张图在原页上的位置"))
    return ws.root / figures.crop(ws.root, page, box)


def extract(ws, block_id: str, cfg: dict, cancel=None, meter=None) -> list[dict]:
    """用翻译引擎看图，得到中英对照的标签，写回 paper.json。返回标签。"""
    key = f"{ws.root}#{block_id}"
    with _lock:
        if key in _busy:
            raise ValueError(tr("这张图正在辨识中"))
        _busy.add(key)
    try:
        paper = ws.load("paper") or {}
        block = next((b for b in paper.get("blocks", []) if b.get("id") == block_id and b.get("type") == "figure"), None)
        if not block:
            raise ValueError(tr("找不到这张图"))
        image = _image(ws, block, ws.load("layout") or {})
        ecfg = engines.for_translation(copy.deepcopy(cfg))
        if ecfg.get("engine") == "openai":
            ecfg["openai"]["vision"] = True  # 这次一定要附图
        mode = engines.image_mode(ecfg)
        hint = f"圖片檔：{image}（請用讀圖工具打開）" if mode == "claude" else ""  # i18n-ok
        target = langs.of_paper(paper.get("meta"))
        text = engines.run(ecfg, prompt(block, target, hint), ws.root, [image] if mode == "attached" else None,
                           cancel, meter, json_mode=True)
        data = engines.parse_json(text)
        labels = normalize_labels((data or {}).get("labels") if isinstance(data, dict) else data)
        if not labels:
            raise engines.EngineError(tr("模型没有在图里找到可辨识的文字"))
        if target == "zh-TW":
            from . import traditional
            holder = {"blocks": [{"image_labels": labels}]}
            traditional.normalize(holder)
            labels = holder["blocks"][0]["image_labels"]

        def apply(p):
            for b in p.get("blocks", []):
                if b.get("id") == block_id:
                    b["image_labels"] = labels
                    b["image_en"] = joined(labels, "en")
                    b["image_zh"] = joined(labels, "zh")
                    if not b.get("src") and str(image).startswith(str(ws.root)):
                        b["src"] = image.relative_to(ws.root).as_posix()
            return p
        ws.update("paper", apply)
        return labels
    finally:
        with _lock:
            _busy.discard(key)

