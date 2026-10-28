/* 显著性说明框：段落里有 β = 0.32, p < .01、0.25*** 这类统计结果时，在这段下面放一个淡色小框，
   逐条用白话说明“在几 % 水准下显著／不显著、系数是正是负”。规则在本机算，不调用模型、不花额度；
   框里有“请 AI 白话解释这段结果”，答案可以再贴成便利贴。Aa 里可以关掉（prefs.sigBox）。 */
(function (PR) {
  "use strict";
  const MAX = 6;
  const TEX = { "\\beta": "β", "\\chi": "χ", "\\alpha": "α", "\\gamma": "γ", "\\eta": "η", "\\rho": "ρ", "\\le": "≤", "\\leq": "≤", "\\ge": "≥", "\\geq": "≥", "\\lt": "<", "\\gt": ">", "\\times": "×", "\\hat": "", "\\text": "", "\\mathrm": "", "\\,": " ", "\\ ": " " };

  /* 段落文字（译文优先），公式记号拿掉，β、χ² 这类换成一般字 */
  function plain(text) {
    return String(text || "").replace(/‖/g, "").replace(/\$([^$]*)\$/g, (m, tex) => {
      let t = tex;
      for (const [k, v] of Object.entries(TEX)) t = t.split(k).join(v);
      return t.replace(/\^\{?2\}?/g, "²").replace(/_\{?([^}\s]*)\}?/g, "$1").replace(/[{}\\]/g, "");
    }).replace(/\s+/g, " ");
  }

  const STAT = /(?<![A-Za-z])(β|B|b|t|F|z|Z|r|R²|R2|χ²|OR|HR|Wald|coef(?:ficient)?|系[数數]|效果[值量]?)\s*(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?\s*[=＝]\s*([−–-]?\s*\d*\.?\d+)/g;
  const PVAL = /(?<![A-Za-z])[pP]\s*(?:值|-value)?\s*(<|>|=|≤|≥|＜|＞|＝|小于|小於|大于|大於)\s*(0?\.\d+|\d\.\d+|\d+)/g;
  const STARS = /([−–-]?\d*\.\d+)(\*{1,3})(?!\*)/g;

  function level(p, op) {
    if (op === ">" || op === "＞" || op === "≥" || /大/.test(op)) return { sig: false, text: PR.t("不显著（p > {p}）", { p }) };  // i18n-ok: 比对全形符号
    const v = parseFloat(p);
    if (!(v >= 0)) return null;
    if (v <= 0.001) return { sig: true, text: PR.t("在 0.1% 水准下显著，极不可能是偶然") };
    if (v <= 0.01) return { sig: true, text: PR.t("在 1% 水准下显著，很不可能是偶然") };
    if (v <= 0.05) return { sig: true, text: PR.t("在 5% 水准下显著（一般常用的门槛）") };
    if (v <= 0.1) return { sig: true, weak: true, text: PR.t("只在 10% 水准下边缘显著，证据偏弱") };
    return { sig: false, text: PR.t("不显著：p = {p} 大于 0.05，不能排除是偶然", { p }) };
  }
  const STAR_LEVEL = { "*": "0.05", "**": "0.01", "***": "0.001" };

  /* 前面最近的统计量（40 个字以内）：“β = 0.32” */
  function statBefore(text, at) {
    const win = text.slice(Math.max(0, at - 48), at);
    let m, last = null;
    STAT.lastIndex = 0;
    while ((m = STAT.exec(win))) last = m;
    return last ? { name: last[1], value: last[2].replace(/\s+/g, "").replace(/[−–]/g, "-") } : null;
  }

  function sign(v) {
    const x = parseFloat(v);
    return !isFinite(x) || x === 0 ? "" : x > 0 ? PR.t("方向为正") : PR.t("方向为负");
  }

  PR.sigItems = function (text) {
    const t = plain(text), out = [], seen = new Set();
    let m;
    PVAL.lastIndex = 0;
    while ((m = PVAL.exec(t)) && out.length < MAX) {
      const op = m[1].replace("＝", "=").replace("＜", "<"), p = m[2], lv = level(p, op);  // i18n-ok: 比对全形符号
      if (!lv) continue;
      const st = statBefore(t, m.index);
      const label = (st ? st.name + " = " + st.value + ", " : "") + "p " + op.replace(/小于|小於/, "<").replace(/大于|大於/, ">") + " " + p;
      if (seen.has(label)) continue;
      seen.add(label);
      const dir = lv.sig && st && /^(β|B|b|t|z|Z|r|OR|HR|coef|系|效果)/.test(st.name) ? sign(st.name === "OR" || st.name === "HR" ? String(parseFloat(st.value) - 1) : st.value) : "";
      out.push({ label, text: lv.text + (dir ? PR.t("，{dir}", { dir }) : ""), sig: lv.sig, weak: lv.weak });
    }
    STARS.lastIndex = 0;
    while ((m = STARS.exec(t)) && out.length < MAX) {
      const label = m[1] + m[2];
      if (seen.has(label)) continue;
      seen.add(label);
      const lv = level(STAR_LEVEL[m[2]], "<");
      const dir = sign(m[1]);
      out.push({ label, text: PR.t("{stars} 表示 p < {p}：", { stars: m[2], p: STAR_LEVEL[m[2]] }) + lv.text + (dir ? PR.t("，{dir}", { dir }) : ""), sig: true });
    }
    return out;
  };

  function boxHtml(id, items) {
    return '<aside class="sig-box" data-sig="' + PR.esc(id) + '" contenteditable="false"><div class="sig-h">' + PR.t("显著性说明") +
      '<span class="grow"></span>' + (PR.canChat && PR.canChat() && PR.feature("chat") ? '<button class="linkish" data-sig-ask>' + PR.t("请 AI 白话解释这段结果") + "</button>" : "") + "</div><ul>" +
      items.map((x) => '<li class="' + (x.sig ? (x.weak ? "weak" : "sig") : "ns") + '"><b>' + PR.esc(x.label) + "</b>" + PR.esc(x.text) + "</li>").join("") +
      '</ul><div class="sig-f">' + PR.t("p 值越小，结果越不像是偶然；常用门槛是 0.05。这里只依数字判断，解读以论文为准。") + "</div></aside>";
  }

  function textOf(b) {
    if (b.type === "para") return b.zh || b.en || "";
    if (b.type === "list") return (b.items || []).map((i) => i.zh || i.en || "").join(" ");
    return "";
  }

  PR.renderSigBoxes = function (onlyId) {
    const blocks = onlyId ? [PR.blockById[onlyId]].filter(Boolean) : (PR.state.paper.blocks || []);
    for (const b of blocks) {
      const host = document.getElementById("b-" + b.id);
      if (!host) continue;
      const old = host.querySelector(":scope > .sig-box");
      if (old) old.remove();
      if (b.type !== "para" && b.type !== "list") continue;  // 关掉时只是隐藏（body.no-sigbox），切回来不用重算
      const items = PR.sigItems(textOf(b));
      if (items.length) host.insertAdjacentHTML("beforeend", boxHtml(b.id, items));
    }
  };

  document.addEventListener("click", (e) => {
    const ask = e.target.closest("[data-sig-ask]");
    if (!ask) return;
    const id = ask.closest(".sig-box").dataset.sig;
    PR.chatAsk({ anchor: id, quote: "", text: PR.t("请用白话解释这段的统计结果：每个系数和 p 值代表什么、哪些显著、哪些不显著，实际意义是什么。") });
  });

  const relayout = () => { if (PR.layoutMargin) PR.layoutMargin(); if (PR.renderStickies) PR.renderStickies(); };  // 框让段落变高：页边卡片、便利贴重新对位
  const redraw = PR.debounce(() => { PR.renderSigBoxes(); relayout(); }, 30);
  PR.on("rendered", redraw);
  PR.on("block-rendered", (id) => { PR.renderSigBoxes(id); relayout(); });
})(window.PR);
