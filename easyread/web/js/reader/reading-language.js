/* 正文显示方式：原文 / 译文 / 双语，双语旁边的 ▾ 选原文在前还是译文在前。只改排列顺序和显隐，
   .zh 始终是译文、data-key 不变，笔记、高亮和改过的译文都还对应原来的内容。
   偏好：mode（zh 单语 / bi 双语 / sent 逐句对照），lead 单语看哪种，biOrder 双语和逐句里哪种在前，两者互不影响。
   逐句对照：有句子对齐（sents，见 sentences.js）的段落，原文一句、译文一句交替排；DOM 不动，只用 flex 的 order 调排列，
   所以划线、笔记、改译文都和双语时一样挂在原来的 .zh / .en 上。没有句子对齐的段落照双语整段显示。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const targetCode = () => (S.paper && S.paper.meta && S.paper.meta.target) || (S.item || {}).target || "zh";
  PR.isBilingual = () => PR.prefs.mode === "bi" || PR.prefs.mode === "sent";
  PR.readingView = () => (PR.prefs.mode === "sent" ? "sentence" : PR.prefs.mode === "bi" ? "both" : PR.prefs.lead === "original" ? "original" : "translation");
  PR.originalFirst = () => (PR.isBilingual() ? PR.prefs.biOrder : PR.prefs.lead) === "original";
  PR.viewLabels = function () {
    const lang = PR.targetName(targetCode());
    return {
      original: PR.t("原文"), translation: PR.t("译文"), both: PR.t("双语"), sentence: PR.t("逐句"),
      originalFull: PR.t("{lang}原文", { lang: PR.t("英文") }), translationFull: PR.t("{lang}译文", { lang }),
    };
  };
  /* 切换显示方式：mode 和 lead / biOrder 一起改，再走 setPref 保住阅读位置 */
  PR.setView = function (view) {
    if (view !== "both" && view !== "sentence") PR.prefs.lead = view;
    PR.setPref("mode", view === "both" ? "bi" : view === "sentence" ? "sent" : "zh");
  };
  PR.setBiOrder = function (first) {
    PR.prefs.biOrder = first;
    PR.setPref("mode", PR.prefs.mode === "sent" ? "sent" : "bi");
  };

  const CARET = '<svg class="i sm" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 8l4 4 4-4"/></svg>';
  function viewTitle(k, L) {
    if (k === "sentence") return PR.t("逐句对照：原文一句、译文一句，{what}在前", { what: PR.prefs.biOrder === "original" ? L.original : L.translation });
    if (k !== "both") return L[k + "Full"];
    return PR.t("双语，{what}在前（B）", { what: PR.prefs.biOrder === "original" ? L.original : L.translation });
  }
  /* 顶栏和窄屏 Aa 共用一份按钮；窄屏没地方弹菜单，顺序直接排成第二行 */
  PR.viewSegHtml = function (narrow) {
    const L = PR.viewLabels(), v = PR.readingView();
    const b = (k) => '<button data-view="' + k + '" class="' + (v === k ? "on" : "") + '" title="' + PR.esc(viewTitle(k, L)) + '">' + PR.esc(L[k]) + "</button>";
    if (!narrow) return '<div class="seg view-seg">' + b("original") + b("translation") + b("both") + b("sentence") + "</div>";
    const o = (k) => '<button data-order="' + k + '" class="' + (PR.prefs.biOrder === k ? "on" : "") + '">' + PR.esc(PR.t("{what}在前", { what: L[k] })) + "</button>";
    return '<div class="seg view-seg">' + b("original") + b("translation") + b("both") + b("sentence") + "</div>" +
      '<div class="order-line"><span>' + PR.t("双语顺序") + '</span><div class="seg">' + o("original") + o("translation") + "</div></div>";
  };

  const menu = PR.el("div", { id: "orderMenu", class: "menu menu-list", role: "menu" });
  document.body.append(menu);
  function renderMenu() {
    const L = PR.viewLabels();
    menu.innerHTML = ["original", "translation"].map((k) => {
      const on = PR.isBilingual() && PR.prefs.biOrder === k;
      return '<button role="menuitemradio" aria-checked="' + on + '" data-order="' + k + '">' +
        '<span class="tick">' + (on ? PR.icon("check", "sm") : "") + "</span>" + PR.esc(PR.t("{what}在前", { what: L[k] })) + "</button>";
    }).join("");
  }
  PR.toggleOrderMenu = function (force) {
    const caret = PR.$("#bar [data-order-menu]");
    const open = force != null ? force : !menu.classList.contains("open");
    if (open && caret) {
      renderMenu();
      const r = caret.getBoundingClientRect();
      menu.style.top = r.bottom + 6 + "px";
      menu.style.left = Math.max(8, Math.min(r.right - 150, innerWidth - 160)) + "px";
    }
    menu.classList.toggle("open", open);
    if (caret) caret.setAttribute("aria-expanded", open);
  };
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-order]");
    if (!b) return;
    PR.toggleOrderMenu(false);
    PR.setBiOrder(b.dataset.order);
  });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#orderMenu, [data-order-menu]")) PR.toggleOrderMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu.classList.contains("open")) PR.toggleOrderMenu(false); });

  function syncBar() {
    const L = PR.viewLabels(), v = PR.readingView();
    PR.$$("#bar [data-view]").forEach((btn) => {
      const k = btn.dataset.view;
      btn.textContent = L[k];
      btn.classList.toggle("on", v === k);
      btn.title = viewTitle(k, L);
    });
    const caret = PR.$("#bar [data-order-menu]");
    if (caret) {
      caret.innerHTML = CARET;
      caret.classList.toggle("on", v === "both" || v === "sentence");
      caret.title = PR.t("双语顺序");
      caret.setAttribute("aria-label", caret.title);
    }
    if (menu.classList.contains("open")) renderMenu();
  }

  PR.applyReadingLanguage = function () {
    const first = PR.originalFirst();
    document.body.classList.toggle("original-first", first);
    syncBar();
    if (!S.paper) return;
    // 标题里的英文（.en-title）拆成和译文同级的一行，才能整体换先后
    PR.$$("#paper .en-title").forEach((en) => {
      const zh = en.parentElement;
      const original = document.createElement(zh.tagName);
      original.className = "en heading-original";
      original.lang = "en";
      const num = zh.querySelector(".num");
      if (num) original.append(num.cloneNode(true));
      original.append(...en.childNodes);
      en.remove();
      zh.after(original);
    });
    PR.$$("#paper .en").forEach((en) => {
      const zh = Array.from(en.parentElement.children).find((n) => n.classList.contains("zh"));
      if (!zh) return;
      zh.classList.add("paired-translation");
      if (first) { if (en.nextElementSibling !== zh) zh.before(en); }
      else if (zh.nextElementSibling !== en) zh.after(en);
    });
    const title = PR.$("#paper .paper-head h1"), meta = S.paper.meta;
    const secondary = PR.$("#paper .title-en");
    if (title && secondary && meta && meta.title_zh && meta.title_en) {
      title.innerHTML = PR.titleHtml(first ? meta.title_en : meta.title_zh);
      secondary.innerHTML = PR.titleHtml(first ? meta.title_zh : meta.title_en);
      const orig = meta.target === "en" ? "" : "en";  // 译成英文时原标题不一定是英文
      title.lang = first ? orig : "";
      secondary.lang = first ? "" : orig;
    }
    const description = PR.$(".reading-language-description");
    if (description && !document.body.classList.contains("en-only") && !((S.paper.translation || {}).en_pages || []).length) {
      const v = PR.readingView();
      description.textContent = v === "both" ? PR.t("正文是原文和译文") : v === "original" ? PR.t("正文是英文原文") : PR.t("正文是译文");
    }
    PR.applySentencePairs();
    PR.hideBlockbar && PR.hideBlockbar();
  };

  /* 逐句对照：一段原文和译文都切成了同样多的句子（.snt[data-s]），才交替排；切不齐就整段显示 */
  PR.applySentencePairs = function () {
    const on = PR.prefs.mode === "sent";
    document.body.classList.toggle("mode-sent", on);
    PR.$$("#paper .sent-pairs").forEach((host) => {
      host.classList.remove("sent-pairs");
      PR.$$(".snt", host).forEach((n) => { n.style.order = ""; n.classList.remove("snt-lead", "snt-follow"); });
    });
    if (!on) return;
    const first = PR.originalFirst();
    PR.$$("#paper .zh[data-key]").forEach((zh) => {
      if (zh.classList.contains("en-main") || !zh.querySelector(".snt")) return;
      const en = PR.enOfZh(zh);
      if (!en) return;
      const zs = PR.$$(":scope > .snt", zh), es = PR.$$(":scope > .snt", en);
      if (!zs.length || zs.length !== es.length) return;
      const host = zh.parentElement;
      host.classList.add("sent-pairs");
      es.forEach((n, i) => { n.style.order = String(2 * i + (first ? 0 : 1)); n.classList.add(first ? "snt-lead" : "snt-follow"); });
      zs.forEach((n, i) => { n.style.order = String(2 * i + (first ? 1 : 0)); n.classList.add(first ? "snt-follow" : "snt-lead"); });
    });
  };
  PR.on("rendered", () => PR.applyReadingLanguage());
  PR.on("block-rendered", () => PR.applyReadingLanguage());
})(window.PR);
