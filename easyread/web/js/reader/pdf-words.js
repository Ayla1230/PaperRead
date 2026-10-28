/* 原页逐字逐行对照（原页面板开着时）：
   - 左边英文原文滑到哪个词，右边 PDF 就框那个词，并淡淡标出它所在的那一行；
   - 左边选取一段英文，右边 PDF 框出同样的字；
   - 往下读时，阅读线（视口上方 30%）上那一行英文对应的 PDF 那一行跟着亮（只看译文时改由逐句跟随）；
   - 反过来在 PDF 上滑过一个词，左边英文同一个词亮起来（CSS Highlight，不改动正文 DOM）。
   对应资料来自 layout.json 的 words：{键: [[词开头, 词结尾, x0, y0, x1, y1], …]}，
   词的位置是“去掉公式后只留英数字”的累计位置（和 pdfwork._word_boxes 同一种算法）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
  const SKIP = ".katex, .stale-tag, .pgmark, .note-pin, .inline-notes, .footnote-label, .editor-wrap";
  const pagesOpen = () => PR.side === "pages";

  function textNodes(host) {
    const out = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }
  /* 英文这一格（.en，或没翻译的 .zh.en-main）对应的键和块 */
  function hostInfo(el) {
    const host = el && el.closest && el.closest("#paper .en, #paper .zh.en-main");
    if (!host) return null;
    const zh = host.classList.contains("zh") ? host : PR.zhOfEl && PR.zhOfEl(host);
    const blk = host.closest(".blk");
    if (!zh || !zh.dataset.key || !blk) return null;
    return { host, key: zh.dataset.key, id: blk.dataset.id };
  }
  function enHostOfKey(key) {
    const zh = PR.$('#paper .zh[data-key="' + CSS.escape(key) + '"]');
    if (!zh) return null;
    return zh.classList.contains("en-main") ? zh : PR.enOfZh && PR.enOfZh(zh);
  }
  /* 正文里某个位置换算成“只留英数字”的累计位置 */
  function offsetOf(host, node, offset) {
    let n = 0;
    for (const t of textNodes(host)) {
      if (t === node) return n + norm(t.data.slice(0, offset)).length;
      n += norm(t.data).length;
    }
    return null;
  }
  /* 反过来：累计位置 [ns, ne) 在正文里的 Range */
  function rangeOf(host, ns, ne) {
    let n = 0, start = null;
    const range = document.createRange();
    for (const t of textNodes(host)) {
      for (let i = 0; i < t.data.length; i++) {
        const k = norm(t.data[i]).length;
        if (!k) continue;
        if (start == null && n >= ns) { range.setStart(t, i); start = true; }
        n += k;
        if (start && n >= ne) { range.setEnd(t, i + 1); return range; }
      }
    }
    return null;
  }
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p && { node: p.offsetNode, offset: p.offset };
    }
    const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    return r && { node: r.startContainer, offset: r.startOffset };
  }
  const wordsOf = (id, key) => { const l = S.layout[id]; return (l && l.words && l.words[key]) || null; };
  const boxOf = (w) => w.slice(2, 6);

  /* 和这个词在原页同一行、同一栏的所有词 → 合成一个行框 */
  function lineBoxes(id, key, w) {
    const loc = S.layout[id];
    const cx = (w[2] + w[4]) / 2, cy = (w[3] + w[5]) / 2;
    const cols = (loc.boxes && loc.boxes.length ? loc.boxes : [loc.box]).filter(Boolean);
    const col = cols.find((b) => cx >= b[0] - 0.01 && cx <= b[2] + 0.01) || [0, 0, 1, 1];
    const all = Object.values(loc.words || {}).flat();
    const same = all.filter((o) => o[3] <= cy && o[5] >= cy && (o[2] + o[4]) / 2 >= col[0] - 0.01 && (o[2] + o[4]) / 2 <= col[2] + 0.01);
    if (!same.length) return [boxOf(w)];
    return [[Math.min(...same.map((o) => o[2])), Math.min(...same.map((o) => o[3])), Math.max(...same.map((o) => o[4])), Math.max(...same.map((o) => o[5]))]];
  }
  /* 一串词的框按行合并（选取一大段时不要几十个小框） */
  function mergeLines(list) {
    const rows = [];
    for (const w of list) {
      const b = boxOf(w), last = rows[rows.length - 1];
      const cyL = last && (last[1] + last[3]) / 2, cyB = (b[1] + b[3]) / 2;
      if (last && Math.abs(cyL - cyB) < (b[3] - b[1]) * 0.6 && b[0] >= last[0] - 0.01 && b[0] - last[2] < 0.04) {
        rows[rows.length - 1] = [Math.min(last[0], b[0]), Math.min(last[1], b[1]), Math.max(last[2], b[2]), Math.max(last[3], b[3])];
      } else rows.push(b.slice());
    }
    return rows;
  }

  /* ---------- 左边滑过英文的词 ---------- */
  let hovering = false, lastMove = null, lastMoveAt = 0;
  // PR.throttle 不会把参数传下去：记下最后一次滑鼠位置再处理
  const onMove = PR.throttle(() => {
    const e = lastMove;
    if (!e) return;
    if (!pagesOpen()) return;
    const info = hostInfo(e.target);
    if (!info) { if (hovering) { hovering = false; PR.pvUnmark("word"); PR.pvUnmark("line"); } return; }
    const list = wordsOf(info.id, info.key);
    const c = caretAt(e.clientX, e.clientY);
    if (!list || !c || !info.host.contains(c.node) || c.node.nodeType !== 3) return;
    const off = offsetOf(info.host, c.node, c.offset);
    if (off == null) return;
    const hit = list.filter((w) => w[0] <= off && off < w[1]);
    if (!hit.length) return;
    hovering = true;
    PR.pvMark(info.id, lineBoxes(info.id, info.key, hit[0]), "line", false);
    PR.pvMark(info.id, hit.map(boxOf), "word", true);
  }, 40);
  document.addEventListener("mousemove", (e) => { lastMove = { target: e.target, clientX: e.clientX, clientY: e.clientY }; lastMoveAt = Date.now(); onMove(); }, { passive: true });

  /* ---------- 左边选取英文 ---------- */
  const onSelect = PR.debounce(() => {
    if (!pagesOpen()) return;
    const sel = getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return PR.pvUnmark("sel");
    const r = sel.getRangeAt(0);
    const a = hostInfo(r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer);
    const b = hostInfo(r.endContainer.nodeType === 3 ? r.endContainer.parentElement : r.endContainer);
    if (!a || !b || a.host !== b.host) return PR.pvUnmark("sel");
    const list = wordsOf(a.id, a.key);
    const ns = offsetOf(a.host, r.startContainer, r.startOffset), ne = offsetOf(a.host, r.endContainer, r.endOffset);
    if (!list || ns == null || ne == null || ne <= ns) return PR.pvUnmark("sel");
    const hit = list.filter((w) => w[1] > ns && w[0] < ne);
    if (!hit.length) return PR.pvUnmark("sel");
    PR.pvMark(a.id, mergeLines(hit), "sel", true);
  }, 120);
  document.addEventListener("selectionchange", onSelect);

  /* ---------- 往下读：阅读线上那一行英文 → PDF 那一行 ---------- */
  /* 一格英文在画面上的范围；逐句模式下 .en 是 display: contents，没有自己的框，就看它的句子 */
  function linesOf(host) {
    if (host.getClientRects().length) return [host.getBoundingClientRect()];
    return PR.$$(":scope > .snt", host).map((n) => n.getBoundingClientRect()).filter((r) => r.height);
  }
  PR.followLine = function () {
    // 滑鼠刚动过、正指着英文：以滑鼠为准；用滚轮往下读时滑鼠不动，就交给阅读线
    if (!pagesOpen() || (hovering && Date.now() - lastMoveAt < 400) || !PR.$(".pv-follow input").checked) return;
    hovering = false;
    const id = PR.readingBlock && PR.readingBlock();
    const loc = S.layout[id];
    if (!loc || !loc.words) return PR.pvUnmark("line");
    const y = PR.readingLine();
    for (const key of Object.keys(loc.words)) {
      const host = enHostOfKey(key);
      if (!host) continue;
      const rects = linesOf(host);
      if (!rects.length) continue;
      // 阅读线穿过的那块英文；逐句模式下阅读线可能落在中文句子上，就用它上面那句英文的最后一行
      const above = rects.filter((r) => r.top <= y);
      const r = above[above.length - 1];
      if (!r || rects[rects.length - 1].bottom < y - 4 && !rects.some((q) => q.top <= y && q.bottom >= y)) continue;
      const yy = Math.min(y, r.bottom - 4);
      const c = caretAt(r.left + 6, yy);
      if (!c || !host.contains(c.node) || c.node.nodeType !== 3) continue;
      const off = offsetOf(host, c.node, c.offset);
      const w = off != null && loc.words[key].find((o) => o[0] <= off && off < o[1]) ||
        loc.words[key].find((o) => o[0] >= (off || 0));
      if (w) return PR.pvMark(id, lineBoxes(id, key, w), "line", true);
    }
    PR.pvUnmark("line");  // 只看译文：交给逐句跟随
  };

  /* ---------- PDF 上滑过一个词 → 左边英文同一个词亮 ---------- */
  const canHighlight = typeof Highlight === "function" && CSS.highlights;
  PR.pdfHoverWord = function (x, y, page) {
    if (x == null) { if (canHighlight) CSS.highlights.delete("pv-word"); PR.pvUnmark("word"); return; }
    for (const id in S.layout) {
      const l = S.layout[id];
      if (l.page !== page || !l.words || !PR.blockById[id]) continue;
      for (const key in l.words) {
        const w = l.words[key].find((o) => x >= o[2] - 0.002 && x <= o[4] + 0.002 && y >= o[3] - 0.002 && y <= o[5] + 0.002);
        if (!w) continue;
        PR.pvMark(id, l.words[key].filter((o) => o[0] === w[0]).map(boxOf), "word", false);
        const host = enHostOfKey(key);
        const range = host && host.getClientRects().length && rangeOf(host, w[0], w[1]);
        if (canHighlight) { if (range) CSS.highlights.set("pv-word", new Highlight(range)); else CSS.highlights.delete("pv-word"); }
        return;
      }
    }
    if (canHighlight) CSS.highlights.delete("pv-word");
    PR.pvUnmark("word");
  };
})(window.PR);
