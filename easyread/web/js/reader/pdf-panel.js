/* 右侧面板：原文页（随阅读位置翻页、框出当前段）。和笔记面板共用右侧，一次开一个。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const body = document.body;
  let pvPage = 1, pvBlock = null;
  const pages = () => (S.paper.meta || {}).pages || [];
  const boxesOf = (loc) => loc.boxes && loc.boxes.length ? loc.boxes : [loc.box];

  /* 右侧面板开关：pages | notes | null */
  /* 面板滑出的同时正文就让位：重排只要几十毫秒（fitWide 不再重量公式），不必等面板滑完再跳一下。 */
  PR.side = null;
  PR.openSide = function (name) {
    PR.side = name;
    body.classList.toggle("pv-open", name === "pages");
    body.classList.toggle("np-open", name === "notes");
    body.classList.toggle("ch-open", name === "chat");
    body.classList.toggle("rp-open", name === "research");
    PR.$('[data-act="chat"]').classList.toggle("on", name === "chat");
    PR.$('[data-act="pages"]').classList.toggle("on", name === "pages");
    PR.$('[data-act="notes"]').classList.toggle("on", name === "notes");
    const researchButton = PR.$('[data-act="research"]');
    if (researchButton) researchButton.classList.toggle("on", name === "research");
    if (name) { const t = PR.$("#toast"); if (t) t.classList.remove("open"); }  // 提示条别挡住面板底部的输入框
    if (body.classList.contains("side-open") === !!name) return;  // 面板之间切换：正文宽度不变
    const anchor = PR.readingBlock && PR.readingBlock();
    const node = anchor && document.getElementById("b-" + anchor);
    const before = node ? node.getBoundingClientRect().top : 0;
    body.classList.toggle("side-open", !!name);
    PR.fitWide(); PR.renderMargin();
    if (node) window.scrollBy(0, node.getBoundingClientRect().top - before);  // 重排后还停在刚才读的地方
  };

  PR.togglePages = function (force) {
    const open = force != null ? force : PR.side !== "pages";
    PR.openSide(open ? "pages" : null);
    if (open) PR.syncPage(true); else pair(null);
  };
  PR.openPage = function (page, blockId) {
    pvBlock = blockId || null;
    if (PR.side !== "pages") PR.openSide("pages");
    showPage(page, blockId);
  };

  /* 原图是 2.4 倍渲染（约 1500 像素宽、几百 KB），面板用不了那么大：要一张和面板一样宽的，服务端生成一次后缓存 */
  function srcOf(n) {
    const p = pages()[n - 1];
    if (!p) return "";
    const base = PR.imageUrl(p.img);
    if (PR.store.mode !== "server") return base;
    const need = (PR.$(".pv-scroll").clientWidth || 480) * (zoom ? zoom.value : 1) * (devicePixelRatio || 1);
    return need <= 1000 ? base + "?w=1000" : need <= 1600 ? base + "?w=1600" : base;  // 1000 宽的服务端已提前生成好
  }
  let pageNodes = [], pageSource = null;
  const scroller = PR.$(".pv-scroll");
  const zoom = PR.initPageZoom ? PR.initPageZoom({
    scroller,
    beforeZoom: () => { panelInput = false; programmaticUntil = Date.now() + 1500; holdUntil = Date.now() + 1500; },
    afterZoom: () => loadNearby(pvPage),
  }) : { value: 1 };
  function loadPage(n) {
    const entry = pageNodes[n - 1];
    if (!entry) return;
    const src = srcOf(n);
    if (entry.img.getAttribute("src") === src) return;
    entry.node.classList.add("loading");
    entry.img.onload = () => entry.node.classList.remove("loading");
    entry.img.setAttribute("src", src);
  }
  function loadNearby(n) {
    for (let i = Math.max(1, n - 2); i <= Math.min(pages().length, n + 2); i++) loadPage(i);
  }
  function ensurePages() {
    if (pageSource === pages()) return;
    pageSource = pages();
    pageNodes = pageSource.map((p, i) => {
      const node = document.createElement("div"), img = document.createElement("img"), hl = document.createElement("div");
      node.className = "pv-page";
      node.dataset.n = String(i + 1);
      node.style.aspectRatio = (p.w || 612) + " / " + (p.h || 792);
      img.alt = "Page " + (i + 1); img.decoding = "async";
      hl.className = "pv-hl";
      node.replaceChildren(img, hl);
      node.addEventListener("click", (e) => pickPage(e, i + 1));
      node.addEventListener("mousemove", (e) => {
        const r = node.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        node.classList.toggle("pickable", !!blockAt(x, y, i + 1));
        hoverPdfSentence(sentenceAt(x, y, i + 1));
        if (PR.pdfHoverWord) PR.pdfHoverWord(x, y, i + 1);
      });
      node.addEventListener("mouseleave", () => { hoverPdfSentence(null); if (PR.pdfHoverWord) PR.pdfHoverWord(null); });
      return { node, img, hl };
    });
    scroller.replaceChildren(...pageNodes.map(p => p.node));
  }
  PR.preloadPage = () => {}; // Images are loaded near the panel viewport.
  function updatePageLabel() {
    PR.$(".pv-label").textContent = PR.t("第 {p} / {n} 页", { p: pvPage, n: pages().length });
    const pdf = PR.$('[data-pv="pdf"]'), url = PR.pdfUrl(pvPage);
    pdf.style.display = url ? "" : "none";
    if (url) pdf.href = url;
  }
  function pageTop(node) {
    return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }
  let panelInput = false, programmaticUntil = 0;
  ["wheel", "pointerdown", "touchstart", "keydown"].forEach(type => scroller.addEventListener(type, () => {
    panelInput = true;
    holdUntil = Date.now() + 2000;
  }, { passive: true }));
  scroller.addEventListener("scrollend", () => { programmaticUntil = 0; });
  // Switching back to the text must immediately return control to that pane.
  ["wheel", "pointerdown", "touchstart", "keydown"].forEach(type => document.addEventListener(type, (e) => {
    if (e.target.closest("#pageview")) return;
    panelInput = false;
    holdUntil = 0;
  }, { passive: true, capture: true }));
  function followPanel(entry, middle) {
    if (!PR.$(".pv-follow input").checked) return;
    const r = entry.node.getBoundingClientRect();
    const y = Math.max(0, Math.min(1, (middle - r.top) / r.height));
    let best = null, bestBox = null, distance = Infinity;
    for (const id in S.layout) {
      const loc = S.layout[id];
      if (loc.page !== pvPage || !PR.blockById[id]) continue;
      for (const box of boxesOf(loc)) {
        if (!box) continue;
        const d = Math.max(box[1] - y, y - box[3], 0);
        if (d < distance) { best = id; bestBox = box; distance = d; }
      }
    }
    // Older imports may have page numbers but no paragraph coordinates.
    if (!best) best = Object.keys(PR.blockById).find(id => PR.blockById[id].page === pvPage);
    const node = best && document.getElementById("b-" + best);
    if (!node) return;
    pvBlock = best;
    highlightBlock(pvPage, best);
    const rect = node.getBoundingClientRect();
    const fraction = bestBox ? Math.max(0, Math.min(1, (y - bestBox[1]) / Math.max(0.001, bestBox[3] - bestBox[1]))) : 0;
    window.scrollTo({ top: Math.max(0, window.scrollY + rect.top + fraction * rect.height - window.innerHeight * 0.3), behavior: "instant" });
  }
  scroller.addEventListener("scroll", () => {
    if (!pageNodes.length || PR.side !== "pages") return;
    // Native scrollbar drags can emit scroll without a DOM pointerdown.
    if (Date.now() >= programmaticUntil) panelInput = true;
    if (panelInput) holdUntil = Date.now() + 2000;
    const middle = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
    const entry = pageNodes.find(p => p.node.getBoundingClientRect().bottom > middle) || pageNodes[pageNodes.length - 1];
    pvPage = Number(entry.node.dataset.n);
    updatePageLabel(); loadNearby(pvPage);
    if (panelInput) followPanel(entry, middle);
  }, { passive: true });

  /* 这段在原页上没有位置（旧论文、文字层读不到、算的时候出错）：面板上方提示，可以按“重新对位”重算 */
  const TEXT_TYPES = ["para", "heading", "list"];
  function hint(blockId, page) {
    const box = PR.$(".pv-hint");
    if (!box) return;
    const b = blockId && PR.blockById[blockId], loc = blockId && S.layout[blockId];
    const missing = b && TEXT_TYPES.includes(b.type) && (!loc || loc.page !== page);
    if (!missing || hint.busy) { if (!hint.busy) box.hidden = true; return; }
    const ids = (S.paper.blocks || []).filter((x) => TEXT_TYPES.includes(x.type) && x.page).map((x) => x.id);
    const found = ids.filter((id) => S.layout[id]).length;
    box.innerHTML = "<span>" + (found ? PR.t("这段在原页上还没对上位置（全篇 {a} / {b} 段有位置）", { a: found, b: ids.length }) : PR.t("这篇还没有原页位置资料，所以右边无法跟随")) + "</span>" +
      (PR.store.mode === "server" ? '<button class="btn sm line" data-pv-relocate>' + PR.t("重新对位") + "</button>" : "");
    box.hidden = false;
  }
  PR.$("#pageview").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-pv-relocate]");
    if (!btn) return;
    const box = PR.$(".pv-hint");
    hint.busy = true;
    box.innerHTML = '<span class="spin"></span> <span>' + PR.t("正在重新计算每段在原页上的位置…") + "</span>";
    try {
      const r = await PR.api("/api/p/" + PR.pid + "/relocate", { method: "POST", body: {} });
      S.layout = r.layout || {};
      hint.busy = false;
      const cur = PR.currentBlock && PR.currentBlock();
      if (r.located) {
        box.hidden = true;
        PR.toast(PR.t("已对上 {a} / {b} 段", { a: r.located, b: r.total }));
        if (cur && S.layout[cur]) showPage(S.layout[cur].page, cur); else highlightBlock(pvPage, cur);
        if (cur && (!S.layout[cur] || S.layout[cur].page !== pvPage)) hint(cur, pvPage);
      } else {
        box.innerHTML = "<span>" + (r.text_layer ? PR.t("还是对不上：原文和 PDF 的文字差太多。请截图回报，附上论文名称。") : PR.t("这份 PDF 读不到文字（可能是扫描档或特殊字型），所以右边无法逐段跟随；翻页仍然可以用。")) + "</span>";
      }
    } catch (err) {
      hint.busy = false;
      box.innerHTML = "<span>" + PR.t("重新对位失败：{msg}", { msg: PR.esc(PR.errorText ? PR.errorText(err) : err.message) }) + "</span>";
    }
  });

  function highlightBlock(page, blockId) {
    hint(blockId, page);
    sentShown = null;
    pageNodes.forEach(p => p.hl.classList.remove("on"));
    const hl = pageNodes[page - 1].hl;
    const loc = blockId && S.layout[blockId];
    pair(loc && loc.page === page ? blockId : null);
    if (loc && loc.page === page) {
      const boxes = boxesOf(loc);
      hl.replaceChildren(...boxes.map(([x0, y0, x1, y1]) => {
        const region = document.createElement("div");
        region.className = "pv-region";
        Object.assign(region.style, { left: (x0 * 100 - 0.4) + "%", top: (y0 * 100 - 0.3) + "%", width: ((x1 - x0) * 100 + 0.8) + "%", height: ((y1 - y0) * 100 + 0.6) + "%" });
        return region;
      }));
      hl.classList.add("on");
    }
  }

  function showPage(page, blockId) {
    const list = pages();
    if (!list.length) return;
    pvPage = Math.min(list.length, Math.max(1, page));
    ensurePages();
    panelInput = false;
    programmaticUntil = Date.now() + 1500;
    const { node } = pageNodes[pvPage - 1];
    loadNearby(pvPage); updatePageLabel();
    highlightBlock(pvPage, blockId);
    const loc = blockId && S.layout[blockId];
    if (loc && loc.page === pvPage) {
      const boxes = boxesOf(loc);
      const [, y0, , y1] = boxes[0];
      scroller.scrollTo({ top: Math.max(0, pageTop(node) + ((y0 + y1) / 2) * node.offsetHeight - scroller.clientHeight / 2), behavior: "smooth" });
    } else {
      scroller.scrollTo({ top: Math.max(0, pageTop(node) - 18), behavior: "smooth" });
    }
  }

  /* ---------- 逐句对应：左边指着哪一句，原页就框哪一句（layout.json 的 snts 是每句逐行的框） ---------- */
  let sentShown = null;  // { id, key, i }
  const sentBoxes = (id, key, i) => { const l = S.layout[id]; return (l && l.snts && l.snts[key] && l.snts[key][i]) || null; };
  function markLeft(key, i) {
    PR.$$("#paper .snt.pv-snt").forEach((n) => n.classList.remove("pv-snt"));
    if (key == null) return;
    const zh = PR.$('#paper .zh[data-key="' + CSS.escape(key) + '"]');
    if (!zh) return;
    const en = PR.enOfZh ? PR.enOfZh(zh) : null;
    [zh, en].forEach((host) => host && PR.$$(':scope > .snt[data-s="' + i + '"]', host).forEach((n) => n.classList.add("pv-snt")));
  }
  /* 原页上把这一句框出来；scroll：句子不在面板可见范围就滚过去 */
  PR.showSentence = function (id, key, i, scroll) {
    if (PR.side !== "pages") return false;
    const boxes = sentBoxes(id, key, i), loc = S.layout[id];
    if (!boxes || !loc) return false;
    if (sentShown && sentShown.id === id && sentShown.key === key && sentShown.i === i) return true;
    if (pvBlock !== id || !pageNodes[loc.page - 1] || !pageNodes[loc.page - 1].hl.classList.contains("on")) {
      pvBlock = id; pvPage = loc.page; ensurePages(); loadNearby(pvPage); updatePageLabel(); highlightBlock(pvPage, id);
    }
    const entry = pageNodes[loc.page - 1];
    PR.$$(".pv-region.sent", entry.hl).forEach((n) => n.remove());
    PR.$$(".pv-region", entry.hl).forEach((n) => n.classList.add("dim"));
    boxes.forEach(([x0, y0, x1, y1]) => {
      const region = document.createElement("div");
      region.className = "pv-region sent";
      Object.assign(region.style, { left: (x0 * 100 - 0.3) + "%", top: (y0 * 100 - 0.25) + "%", width: ((x1 - x0) * 100 + 0.6) + "%", height: ((y1 - y0) * 100 + 0.5) + "%" });
      entry.hl.append(region);
    });
    entry.hl.classList.add("on");
    sentShown = { id, key, i };
    markLeft(key, i);
    if (scroll) {
      const top = pageTop(entry.node) + boxes[0][1] * entry.node.offsetHeight;
      const bottom = pageTop(entry.node) + boxes[boxes.length - 1][3] * entry.node.offsetHeight;
      const view0 = scroller.scrollTop + 40, view1 = scroller.scrollTop + scroller.clientHeight - 40;
      if (top < view0 || bottom > view1) {
        panelInput = false; programmaticUntil = Date.now() + 1200;
        scroller.scrollTo({ top: Math.max(0, (top + bottom) / 2 - scroller.clientHeight * 0.4), behavior: "smooth" });
      }
    }
    return true;
  };
  PR.clearSentence = function () {
    if (!sentShown) return;
    const loc = S.layout[sentShown.id];
    sentShown = null;
    markLeft(null);
    const entry = loc && pageNodes[loc.page - 1];
    if (!entry) return;
    PR.$$(".pv-region.sent", entry.hl).forEach((n) => n.remove());
    PR.$$(".pv-region.dim", entry.hl).forEach((n) => n.classList.remove("dim"));
  };
  /* ---------- 给 pdf-words.js 用：在原页上画某一类框（word 词 / line 行 / sel 选取） ---------- */
  PR.pvMark = function (id, boxes, cls, scroll) {
    if (PR.side !== "pages") return false;
    const loc = S.layout[id];
    if (!loc || !boxes || !boxes.length) { PR.pvUnmark(cls); return false; }
    if (pvBlock !== id || !pageNodes[loc.page - 1] || !pageNodes[loc.page - 1].hl.classList.contains("on")) {
      pvBlock = id; pvPage = loc.page; ensurePages(); loadNearby(pvPage); updatePageLabel(); highlightBlock(pvPage, id);
    }
    const entry = pageNodes[loc.page - 1];
    PR.pvUnmark(cls);
    PR.$$(".pv-region:not(.sent):not(.word):not(.line):not(.sel)", entry.hl).forEach((n) => n.classList.add("dim"));
    boxes.forEach(([x0, y0, x1, y1]) => {
      const region = document.createElement("div");
      region.className = "pv-region " + cls;
      Object.assign(region.style, { left: (x0 * 100 - 0.2) + "%", top: (y0 * 100 - 0.2) + "%", width: ((x1 - x0) * 100 + 0.4) + "%", height: ((y1 - y0) * 100 + 0.4) + "%" });
      entry.hl.append(region);
    });
    entry.hl.classList.add("on");
    if (scroll) {
      const top = pageTop(entry.node) + Math.min(...boxes.map((b) => b[1])) * entry.node.offsetHeight;
      const bottom = pageTop(entry.node) + Math.max(...boxes.map((b) => b[3])) * entry.node.offsetHeight;
      const view0 = scroller.scrollTop + 40, view1 = scroller.scrollTop + scroller.clientHeight - 40;
      if (top < view0 || bottom > view1) {
        panelInput = false; programmaticUntil = Date.now() + 1200;
        scroller.scrollTo({ top: Math.max(0, (top + bottom) / 2 - scroller.clientHeight * 0.4), behavior: "smooth" });
      }
    }
    return true;
  };
  PR.pvUnmark = function (cls) { PR.$$(".pv-region." + cls, scroller).forEach((n) => n.remove()); };

  /* 原页上滑过某一句 → 左边对应的那句（原文和译文）一起亮 */
  function sentenceAt(x, y, page) {
    for (const id in S.layout) {
      const l = S.layout[id];
      if (l.page !== page || !l.snts || !PR.blockById[id]) continue;
      for (const key in l.snts) {
        const list = l.snts[key];
        for (let i = 0; i < list.length; i++) {
          if ((list[i] || []).some(([x0, y0, x1, y1]) => x >= x0 - 0.004 && x <= x1 + 0.004 && y >= y0 - 0.003 && y <= y1 + 0.003)) return { id, key, i };
        }
      }
    }
    return null;
  }
  function hoverPdfSentence(hit) {
    if (!hit) { if (sentShown && sentShown.fromPdf) PR.clearSentence(); return; }
    if (PR.showSentence(hit.id, hit.key, hit.i, false)) sentShown.fromPdf = true;
  }
  /* 左边滑过一句 → 原页框这一句（原页面板开着时） */
  document.addEventListener("mouseover", (e) => {
    if (PR.side !== "pages") return;
    const snt = e.target.closest && e.target.closest("#paper .snt");
    if (!snt) return;
    const host = snt.parentElement;
    const zh = host && (host.classList.contains("zh") ? host : PR.zhOfEl && PR.zhOfEl(host));
    const blk = snt.closest(".blk");
    if (!zh || !zh.dataset.key || !blk) return;
    holdUntil = Date.now() + 1500;  // 别让滚动跟随马上换掉
    const id = blk.dataset.id;
    if (PR.showSentence(id, zh.dataset.key, Number(snt.dataset.s), true)) return;
    // 这一句在原页上没对到（扫描档、跨页的那一截）：至少框出整段
    const loc = S.layout[id];
    if (loc && pvBlock !== id) { pvBlock = id; showPage(loc.page, id); }
  });
  document.addEventListener("mouseout", (e) => {
    if (!sentShown || sentShown.fromPdf || PR.side !== "pages") return;
    const from = e.target.closest && e.target.closest("#paper .snt");
    const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("#paper .snt");
    if (from && !to) followSentence();
  });
  /* 滚动时跟随：阅读线（视口上方 30%）穿过的那一句 */
  function followSentence() {
    if (PR.side !== "pages" || !PR.$(".pv-follow input").checked || Date.now() < holdUntil) return;
    const id = PR.readingBlock && PR.readingBlock();
    const blk = id && document.getElementById("b-" + id);
    const loc = S.layout[id];
    if (!blk || !loc || !loc.snts) { PR.clearSentence(); return; }
    const line = PR.readingLine();
    let hit = null;
    for (const zh of PR.$$(".zh[data-key]", blk)) {
      if (!loc.snts[zh.dataset.key]) continue;
      // 显示的是原文还是译文都行：两边的句子编号一样，挑看得见的那一边
      const hosts = [zh, PR.enOfZh ? PR.enOfZh(zh) : null].filter((h) => h && h.getClientRects().length);
      for (const host of hosts) {
        for (const n of PR.$$(":scope > .snt", host)) {
          const r = n.getBoundingClientRect();
          if (!r.height) continue;
          if (r.top <= line) hit = { key: zh.dataset.key, i: Number(n.dataset.s) };
        }
        if (hit) break;
      }
    }
    if (!hit) { const first = Object.keys(loc.snts)[0]; hit = first ? { key: first, i: 0 } : null; }
    if (hit) PR.showSentence(id, hit.key, hit.i, true); else PR.clearSentence();
  }
  PR.syncSentence = PR.throttle ? PR.throttle(followSentence, 150) : followSentence;

  /* 译文里和原页框对应的那段也标出来（同一个颜色），一眼看出左右是哪两段 */
  let paired = null, holdUntil = 0;
  function pair(id) {
    if (paired === id) return;
    const old = paired && document.getElementById("b-" + paired);
    if (old) old.classList.remove("pv-pair");
    paired = id;
    const node = id && document.getElementById("b-" + id);
    if (node) node.classList.add("pv-pair");
  }
  PR.on("block-rendered", (id) => { if (id === paired) { paired = null; pair(id); } });  // 段落重画后补回标记
  PR.on("rendered", () => { const id = paired; paired = null; pair(id); });
  PR.on("remote", (changed) => { if (PR.side === "pages" && changed.includes("layout")) showPage(pvPage, pvBlock); });

  /* 点原页上的某一段 → 正文跳到那段译文（排版特殊、看不出语序时，从原文找回去） */
  function blockAt(x, y, page = pvPage) {
    let best = null, area = Infinity;
    for (const id in S.layout) {
      const l = S.layout[id];
      if (l.page !== page || !PR.blockById[id]) continue;
      for (const [x0, y0, x1, y1] of boxesOf(l)) {
        const a = (x1 - x0) * (y1 - y0);
        if (x >= x0 - 0.01 && x <= x1 + 0.01 && y >= y0 - 0.006 && y <= y1 + 0.006 && a < area) { best = id; area = a; }
      }
    }
    return best;
  }
  function pickPage(e, page) {
    const r = e.currentTarget.getBoundingClientRect();
    const id = blockAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, page);
    if (!id) return;
    pvPage = page;
    pvBlock = id;
    holdUntil = Date.now() + 1500;  // 跳过去的滚动会触发“跟随阅读位置”，别让它把刚点的段换掉
    showPage(pvPage, id);
    PR.jumpTo("b-" + id);
  }

  PR.syncPage = function (force) {
    if (PR.side !== "pages") return;
    if (!force && (!PR.$(".pv-follow input").checked || Date.now() < holdUntil)) return;
    const reading = PR.readingBlock();
    // Selection controls an explicit click; scrolling follows the viewport.
    const id = force ? (PR.currentBlock && PR.currentBlock()) || reading : reading;
    const b = PR.blockById[id];
    if (!b) {  // 还在标题区，不在任何一段上：给第 1 页，别让面板空着
      if (force || pvBlock) { pvBlock = null; showPage(1); }
      return;
    }
    if (!force && id === pvBlock) return followSentence();
    pvBlock = id;
    const loc = S.layout[id];
    showPage(loc ? loc.page : b.page, id);
    followSentence();
  };

  PR.$(".pv-follow input")?.addEventListener("change", () => {
    if (!PR.$(".pv-follow input").checked) return;
    panelInput = false;
    holdUntil = 0;
    pvBlock = null;
    PR.syncPage(false);
  });

  PR.$("#pageview").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pv]");
    if (!b) return;
    const act = b.dataset.pv;
    if (act === "close") { PR.togglePages(false); pair(null); }
    if (act === "prev") PR.pageStep(-1);
    if (act === "next") PR.pageStep(1);
  });
  PR.refreshPages = () => showPage(pvPage);  // 面板宽度变了，按新宽度换图
  PR.pageStep = (d) => {
    showPage(pvPage + d);
    const entry = pageNodes[pvPage - 1];
    if (!entry) return;
    holdUntil = Date.now() + 2000;
    followPanel(entry, entry.node.getBoundingClientRect().top);
  };
})(window.PR);
