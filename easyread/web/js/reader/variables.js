/* 研究变数标示：顶栏“变数”→ 请模型列出自变数、依变数、中介、调节、控制变数（variables.py），
   正文里按角色上色。用 CSS Custom Highlight API 画在文字上，不改 DOM，PDF 逐字跟随、划线、笔记都不受影响。
   鼠标停在标色的词上会显示“自变数 · 知觉行为控制（PBC）”。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const ROLES = [["iv", PR.t("自变数")], ["dv", PR.t("依变数")], ["med", PR.t("中介变数")], ["mod", PR.t("调节变数")], ["ctrl", PR.t("控制变数")]];
  const roleName = (r) => (ROLES.find((x) => x[0] === r) || [r, r])[1];
  const KEY = "pr-vars-on";
  const supported = !!(window.CSS && CSS.highlights && window.Highlight);
  let busy = false, spans = [];  // spans：[{range, v}] 给鼠标提示用

  const data = () => (S.paper && S.paper.variables) || null;
  const items = () => ((data() || {}).items || []);
  const isOn = () => { try { return localStorage.getItem(KEY) !== "0"; } catch (e) { return true; } };
  const setOn = (v) => { try { localStorage.setItem(KEY, v ? "1" : "0"); } catch (e) { /* 存不了就只在这次有效 */ } };

  /* ---------- 在正文里找出来、上色 ---------- */
  function clear() { if (supported) ROLES.forEach(([r]) => CSS.highlights.delete("var-" + r)); spans = []; }

  PR.paintVariables = function () {
    clear();
    if (!supported || !isOn() || !items().length) return;
    const lookup = new Map(), terms = [];
    for (const v of items()) for (const t of v.terms || []) {
      const k = t.toLowerCase();
      if (!lookup.has(k)) { lookup.set(k, v); terms.push(t); }
    }
    if (!terms.length) return;
    terms.sort((a, b) => b.length - a.length);  // 长的先比：Perceived behavioral control 不要只标到 behavioral control
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const latin = (t) => /^[\x00-\x7f]+$/.test(t);
    const re = new RegExp(terms.map((t) => latin(t) ? "(?<![A-Za-z0-9])" + esc(t) + "(?![A-Za-z0-9])" : esc(t)).join("|"), "gi");
    const ranges = {};
    const root = PR.$("#paper");
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.parentElement.closest(".katex, .sticky-layer, textarea, input, script, style, .fig-text-btn, .refs") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(n.data))) {
        const v = lookup.get(m[0].toLowerCase().replace(/\s+/g, " ")) || items().find((x) => (x.terms || []).some((t) => new RegExp("^" + esc(t) + "$", "i").test(m[0])));
        if (!v) continue;
        const r = document.createRange();
        r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        (ranges[v.role] = ranges[v.role] || []).push(r);
        spans.push({ range: r, v });
      }
    }
    for (const [role, list] of Object.entries(ranges)) CSS.highlights.set("var-" + role, new Highlight(...list));
  };

  /* ---------- 鼠标停在标色的词上：显示角色和中英文名 ---------- */
  const tip = () => PR.$("#varTip") || document.body.appendChild(PR.el("div", { id: "varTip", role: "tooltip" }));
  document.addEventListener("mousemove", PR.debounce((e) => {
    if (!spans.length) return;
    const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(e.clientX, e.clientY) : null;
    const node = pos ? pos.offsetNode : document.caretRangeFromPoint && (document.caretRangeFromPoint(e.clientX, e.clientY) || {}).startContainer;
    const offset = pos ? pos.offset : document.caretRangeFromPoint && (document.caretRangeFromPoint(e.clientX, e.clientY) || {}).startOffset;
    const hit = node && spans.find((s) => s.range.startContainer === node && offset >= s.range.startOffset && offset <= s.range.endOffset);
    const t = tip();
    if (!hit) { t.classList.remove("open"); return; }
    const v = hit.v;
    t.className = "open var-tip-" + v.role;
    t.innerHTML = "<b>" + PR.esc(roleName(v.role)) + "</b> · " + PR.esc(v.zh || v.en) + (v.zh && v.en && v.zh !== v.en ? ' <span lang="en">' + PR.esc(v.en) + "</span>" : "") + (v.abbr ? " (" + PR.esc(v.abbr) + ")" : "");
    const b = hit.range.getBoundingClientRect();
    t.style.left = Math.max(8, Math.min(innerWidth - t.offsetWidth - 8, b.left)) + "px";
    t.style.top = (b.top > 60 ? b.top - t.offsetHeight - 6 : b.bottom + 6) + "px";
  }, 60));

  /* ---------- 顶栏的“变数”面板 ---------- */
  const pop = () => PR.$("#varPop") || document.body.appendChild(PR.el("div", { id: "varPop", class: "var-pop", role: "dialog" }));

  function estimate() {
    const chars = (S.paper.blocks || []).reduce((n, b) => n + String(b.en || b.zh || b.caption_en || "").length, 0);
    return Math.max(1, Math.round(Math.min(chars, 60000) / 4 / 1000));  // 英文约 4 字元一个 token
  }

  function render() {
    const d = data(), list = items();
    const canAsk = PR.store && PR.store.mode === "server" && PR.canAsk && PR.canAsk();
    let h = '<div class="vp-head"><b>' + PR.t("研究变数") + "</b>" + (list.length ? '<label class="vp-on"><input type="checkbox" data-v="toggle"' + (isOn() ? " checked" : "") + "> " + PR.t("在文中标出") + "</label>" : "") + "</div>";
    if (!supported) h += '<p class="hint">' + PR.t("这个浏览器不支持文字标色，请更新浏览器或用桌面版。") + "</p>";
    if (list.length) {
      h += ROLES.map(([r, name]) => {
        const vs = list.filter((v) => v.role === r);
        return vs.length ? '<div class="vp-role"><span class="vp-chip var-' + r + '">' + name + "</span><ul>" + vs.map((v) => "<li><b>" + PR.esc(v.zh || v.en) + "</b>" +
          (v.zh && v.en && v.zh !== v.en ? ' <span lang="en">' + PR.esc(v.en) + "</span>" : "") + (v.abbr ? ' <em>' + PR.esc(v.abbr) + "</em>" : "") + "</li>").join("") + "</ul></div>" : "";
      }).join("");
      h += '<p class="vp-foot">' + PR.t("由 AI 依研究架构和假设判断，可能有误；以论文为准。") + "</p>";
    } else if (d) {
      h += '<p class="hint">' + PR.t("AI 没有在这篇找到自变数、依变数这类研究变数（可能不是实证研究）。") + "</p>";
    } else {
      h += '<p class="hint">' + PR.t("请 AI 读一次整篇原文，找出自变数、依变数、中介、调节和控制变数，再在正文里依角色上色。") + "</p>";
    }
    if (canAsk) {
      h += '<div class="vp-acts"><button class="btn sm ' + (list.length ? "line" : "accent") + '" data-v="extract"' + (busy ? " disabled" : "") + ">" +
        (busy ? '<span class="spin"></span> ' + PR.t("正在找…") : d ? PR.t("重新找") : PR.t("找出研究变数")) + "</button>" +
        '<span class="vp-cost">' + PR.t("会调用一次模型，约 {n} 千 token", { n: estimate() + 1 }) + "</span>" +
        (d ? '<button class="btn sm line" data-v="clear">' + PR.t("清除") + "</button>" : "") + "</div>";
    }
    pop().innerHTML = h;
  }

  function place(btn) {
    const p = pop(), r = btn.getBoundingClientRect();
    p.style.top = r.bottom + 6 + "px";
    p.style.left = Math.max(8, Math.min(innerWidth - p.offsetWidth - 8, r.right - p.offsetWidth)) + "px";
  }

  PR.toggleVariables = function (btn) {
    const p = pop();
    if (p.classList.contains("open")) return p.classList.remove("open");
    render(); p.classList.add("open"); place(btn);
  };

  async function extract() {
    busy = true; render();
    try {
      const r = await PR.api("/api/p/" + PR.pid + "/variables", { method: "POST", body: {} });
      S.paper.variables = r.variables;
      setOn(true);
      PR.toast((r.variables.items || []).length ? PR.t("找到 {n} 个研究变数", { n: r.variables.items.length }) : PR.t("这篇没有找到研究变数"));
    } catch (e) {
      PR.toast(PR.t("没找成：{msg}", { msg: PR.esc(PR.errorText ? PR.errorText(e) : e.message) }));
    }
    busy = false; render(); PR.paintVariables(); button();
  }

  document.addEventListener("click", async (e) => {
    const p = PR.$("#varPop");
    const v = e.target.closest("#varPop [data-v]");
    if (v && v.dataset.v === "extract") return extract();
    if (v && v.dataset.v === "clear") {
      await PR.api("/api/p/" + PR.pid + "/variables", { method: "POST", body: { clear: true } });
      delete S.paper.variables; render(); PR.paintVariables(); button(); return;
    }
    if (p && p.classList.contains("open") && !e.target.closest("#varPop, #varBtn")) p.classList.remove("open");
  });
  document.addEventListener("change", (e) => {
    if (e.target.matches('#varPop [data-v="toggle"]')) { setOn(e.target.checked); PR.paintVariables(); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { const p = PR.$("#varPop"); if (p) p.classList.remove("open"); } });

  /* 顶栏按钮：放在“研究”后面；找到变数后旁边写个数 */
  function button() {
    let btn = PR.$("#varBtn");
    if (!btn) {
      const after = PR.$('[data-act="research"]');
      if (!after) return;
      btn = PR.el("button", { class: "btn", id: "varBtn", title: PR.t("标出研究变数：自变数、依变数、中介、调节、控制") });
      after.insertAdjacentElement("afterend", btn);
      btn.onclick = () => PR.toggleVariables(btn);
    }
    const n = items().length;
    btn.innerHTML = '<span class="var-dots"><i class="var-iv"></i><i class="var-dv"></i><i class="var-med"></i></span><span>' + PR.t("变数") + "</span>" + (n ? "<b>" + n + "</b>" : "");
    btn.hidden = !(n || (PR.store && PR.store.mode === "server"));  // 离线版没变数就不显示
  }

  const repaint = PR.debounce(() => { button(); PR.paintVariables(); }, 120);
  PR.on("rendered", repaint);
  PR.on("block-rendered", repaint);
})(window.PR);
