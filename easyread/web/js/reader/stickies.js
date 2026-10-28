/* 便利贴：把问 AI 的回答（例如“解释公式”）贴在那一段旁边，可以拖动、调整大小、收起、删除。
   存成一条 kind: "sticky" 的笔记（和其他笔记一样同步、离线版存在浏览器、匯出到笔记里）；
   位置 sticky = {dx, dy, w, h, collapsed} 是相对所属段落左上角的像素，段落重排后跟着走。
   不存 quote，免得在正文里多出一条划线；问题和引用的原文放在 ask / ask_quote。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const W = 340, MIN_W = 220, MIN_H = 90;

  const list = () => PR.myNotes().filter((n) => n.kind === "sticky" && n.anchor && document.getElementById("b-" + n.anchor));
  const paper = () => PR.$("#paper");

  /* 解释公式：用预设的问题问 AI，答案在问 AI 面板里，按“贴成便利贴”才放到版面上 */
  PR.explainFormula = function (anchor, tex) {
    if (!(PR.canChat && PR.canChat())) return PR.toast(PR.t("先在设置里选一个能问 AI 的模型"));
    const b = PR.blockById[anchor] || {};
    const quote = b.type === "math" && (!tex || tex === b.tex) ? "" : String(tex || "").trim();
    PR.chatAsk({ anchor, quote, text: PR.t("请解释这个公式：每个符号代表什么、它在算什么、直觉上怎么理解，最后用一个简单的数字例子示范怎么算。"), explain: true });
  };

  PR.addSticky = function ({ anchor, body, ask, askQuote, model, title }) {
    if (!anchor || !PR.blockById[anchor]) anchor = (PR.currentBlock && PR.currentBlock()) || Object.keys(PR.blockById)[0];
    const host = document.getElementById("b-" + anchor);
    const width = Math.min(W, Math.max(MIN_W, (host ? host.offsetWidth : W) - 16));
    const note = {
      id: PR.uid("n"), kind: "sticky", anchor, body: String(body || "").trim(), ask: ask || "", ask_quote: askQuote || "", model: model || "",
      title: title || PR.t("AI 解答"), color: "yellow", created: PR.nowIso(),
      sticky: { dx: host ? Math.max(0, host.offsetWidth - width) : 0, dy: host ? host.offsetHeight + 8 : 0, w: width, h: 0, collapsed: false },
    };
    PR.saveNote(note);
    requestAnimationFrame(() => {
      const el = PR.$('.sticky[data-sticky="' + note.id + '"]');
      if (el) { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 900); }
    });
    return note;
  };

  function save(n, patch) {
    PR.saveNote(Object.assign({}, n, { sticky: Object.assign({}, n.sticky || {}, patch) }));
  }

  function html(n) {
    const s = n.sticky || {};
    return '<div class="sticky c-' + PR.esc(n.color || "yellow") + (s.collapsed ? " collapsed" : "") + '" data-sticky="' + PR.esc(n.id) + '" role="note">' +
      '<div class="st-head" title="' + PR.t("拖这里移动") + '"><span class="st-title">' + PR.icon("sparkle", "sm") + PR.esc(n.title || PR.t("AI 解答")) + "</span>" +
      '<button data-st="collapse" title="' + (s.collapsed ? PR.t("展开") : PR.t("收起")) + '">' + (s.collapsed ? "+" : "−") + "</button>" +
      '<button data-st="del" title="' + PR.t("拿掉这张便利贴") + '">×</button></div>' +
      '<div class="st-body">' + PR.mdBlocks(n.body || "") + "</div></div>";
  }

  /* 段落位置 + 存下的偏移 = 便利贴位置；超出画面就推回来 */
  function place(el, n) {
    const host = document.getElementById("b-" + n.anchor), p = paper();
    if (!host || !p) return;
    const pr = p.getBoundingClientRect(), br = host.getBoundingClientRect(), s = n.sticky || {};
    const w = Math.max(MIN_W, s.w || W);
    const minX = 8 - pr.left, maxX = document.documentElement.clientWidth - pr.left - w - 8;
    el.style.width = w + "px";
    el.style.height = !s.collapsed && s.h ? Math.max(MIN_H, s.h) + "px" : "";
    el.style.left = Math.round(Math.min(maxX, Math.max(minX, br.left - pr.left + (s.dx || 0)))) + "px";
    el.style.top = Math.round(br.top - pr.top + (s.dy || 0)) + "px";
  }

  let observer = null;
  PR.renderStickies = function () {
    const p = paper();
    if (!p) return;
    let layer = p.querySelector(":scope > .sticky-layer");
    if (!layer) { layer = PR.el("div", { class: "sticky-layer" }); p.appendChild(layer); }
    const notes = list();
    if (observer) observer.disconnect();
    layer.innerHTML = notes.map(html).join("");
    notes.forEach((n) => place(layer.querySelector('[data-sticky="' + CSS.escape(n.id) + '"]'), n));
    if (window.ResizeObserver) {  // 拖右下角改大小：停手后存下来（跟存的一样就不存，免得一直重画）
      observer = new ResizeObserver(PR.debounce((entries) => {
        for (const entry of entries) {
          const el = entry.target, n = (S.reader.notes || {})[el.dataset.sticky];
          if (!n || el.classList.contains("collapsed") || el.classList.contains("dragging")) continue;
          const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight), s = n.sticky || {};
          const sized = !!el.style.height;  // 浏览器的调整大小会在元素上写 width/height
          if (Math.abs(w - (s.w || W)) > 2 || (sized && Math.abs(h - (s.h || 0)) > 2)) save(n, { w, h: sized ? h : s.h || 0 });
        }
      }, 400));
      layer.querySelectorAll(".sticky").forEach((el) => observer.observe(el));
    }
  };

  /* 拖标题栏移动 */
  document.addEventListener("pointerdown", (e) => {
    const head = e.target.closest(".sticky .st-head");
    if (!head || e.target.closest("button") || e.button !== 0) return;
    const el = head.parentElement, n = (S.reader.notes || {})[el.dataset.sticky];
    if (!n) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop };
    el.classList.add("dragging");
    head.setPointerCapture(e.pointerId);
    const move = (ev) => { el.style.left = start.left + ev.clientX - start.x + "px"; el.style.top = start.top + ev.clientY - start.y + "px"; };
    const up = () => {
      head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); head.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
      const host = document.getElementById("b-" + n.anchor), p = paper();
      if (!host || !p) return;
      const pr = p.getBoundingClientRect(), br = host.getBoundingClientRect();
      if (Math.abs(el.offsetLeft - start.left) + Math.abs(el.offsetTop - start.top) < 2) return;
      save(n, { dx: Math.round(el.offsetLeft - (br.left - pr.left)), dy: Math.round(el.offsetTop - (br.top - pr.top)) });
    };
    head.addEventListener("pointermove", move); head.addEventListener("pointerup", up); head.addEventListener("pointercancel", up);
  });

  document.addEventListener("click", (e) => {
    const b = e.target.closest(".sticky [data-st]");
    if (!b) return;
    const n = (S.reader.notes || {})[b.closest(".sticky").dataset.sticky];
    if (!n) return;
    if (b.dataset.st === "collapse") return save(n, { collapsed: !(n.sticky || {}).collapsed });
    if (b.dataset.st === "del") {
      PR.commit({ op: "note_del", id: n.id });
      PR.toast(PR.t("已拿掉便利贴"), { label: PR.t("复原"), fn: () => PR.saveNote(Object.assign({}, n, { deleted: false })) }, 5000);
    }
  });

  const rerender = PR.debounce(() => PR.renderStickies(), 60);
  PR.on("rendered", rerender);
  PR.on("block-rendered", rerender);
  PR.on("remote", rerender);
  PR.on("reader", (op) => { if (op && (op.op === "note" || op.op === "note_del")) rerender(); });
  window.addEventListener("resize", rerender);
})(window.PR);
