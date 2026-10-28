/* 文献库首页的“问 AI”：不用先打开论文，导入 PDF 之前就能问，例如“Perceived behavioral control 的中文是知觉行为控制吗？”
   只用设置里走 API Key 的模型（费用从你自己的 API 额度扣），会参考文献库各篇论文术语表里已有的译名。
   后端见 easyread/ask.py：GET /api/ask 取对话和模型，POST /api/ask 流式回答（一行一个 JSON）。
   附件：按 📎 或把 PDF 拖进面板，先导入文献库（不翻译，不花额度），再带着这篇问问题，像传档案给聊天机器人一样；
   对话记得附过哪篇，之后的追问都带着它。 */
(function (PR) {
  "use strict";
  const st = { open: false, loaded: false, threads: [], models: [], model: "", cur: null, streaming: null, listOpen: false, glossary: true, error: "", attach: null };
  const EXAMPLES = [
    "Perceived behavioral control 的中文是知觉行为控制吗？属于哪个理论？",  // i18n-ok: 显示时套 PR.t
    "“主观规范”是计划行为理论（TPB）的构面吗？和描述性规范差在哪？",  // i18n-ok: 显示时套 PR.t
    "Technology Acceptance Model 里的 perceived usefulness 常见的中文译名有哪些？",  // i18n-ok: 显示时套 PR.t
  ];

  const panel = PR.el("aside", { id: "askPanel", class: "ask-panel", "aria-label": PR.t("问 AI"), "aria-hidden": "true" });
  panel.dataset.dropLabel = PR.t("放开就附上这篇 PDF");
  document.body.append(panel);
  const thread = () => st.threads.find((t) => t.id === st.cur) || null;
  const modelOf = (id) => st.models.find((m) => m.id === id) || null;

  async function load() {
    try {
      const r = await PR.api("/api/ask");
      st.threads = r.threads || [];
      st.models = r.models || [];
      if (!modelOf(st.model)) st.model = r.default || (st.models[0] || {}).id || "";
      st.loaded = true; st.error = "";
    } catch (e) { st.error = PR.errorText ? PR.errorText(e) : e.message; }
    render();
  }

  function messageHtml(m) {
    if (m.role === "user") return '<div class="cm user"><div class="bubble">' + PR.esc(m.content).replace(/\n/g, "<br>") + "</div></div>";
    const hits = m.glossary && m.glossary.length
      ? '<div class="ask-hits"><b>' + PR.t("参考了文献库里的译名：") + "</b>" + m.glossary.map((h) => '<span title="' + PR.esc(PR.t("出自：{papers}", { papers: h.papers.join(", ") })) + '">' + PR.esc(h.en) + " → " + PR.esc(h.zh) + "</span>").join("") + "</div>" : "";
    const usage = m.usage && PR.usageShort ? PR.usageShort(m.usage) : "";
    const paper = m.paper ? '<div class="ask-hits"><b>' + PR.t("读了：") + "</b><span>" + PR.esc(m.paper.title) + "</span>" +
      (m.paper.pages ? "<small>" + PR.t("{n} 页", { n: m.paper.pages }) + (m.paper.truncated ? PR.t("，太长只读了前后大部分") : "") + "</small>" : "") + "</div>" : "";
    return '<div class="cm ai"><div class="who"><span class="av">' + PR.icon("sparkle", "sm") + "</span>" + PR.esc(m.model || PR.t("AI")) +
      (usage ? '<span class="ask-usage">' + PR.esc(usage) + "</span>" : "") + "</div>" + paper + hits +
      '<div class="body">' + (m.content ? PR.mdBlocks(m.content, { cite: false, xref: false }) : (st.streaming && st.streaming.msg === m ? '<span class="spin"></span>' : "")) +
      (m.error ? '<p class="ask-error">' + PR.esc(m.error) + "</p>" : "") + "</div></div>";
  }

  /* ---------- 附件：PDF 先导入文献库（不翻译），再带着它问 ---------- */
  const fileInput = PR.el("input", { type: "file", accept: "application/pdf,.pdf", hidden: true });
  document.body.append(fileInput);
  fileInput.addEventListener("change", () => { const f = fileInput.files[0]; fileInput.value = ""; if (f) attachFile(f); });
  async function attachFile(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return PR.toast(PR.t("只支持 PDF 文件"));
    st.attach = { title: file.name.replace(/\.pdf$/i, ""), uploading: true };
    render();
    try {
      const r = await PR.api("/api/import?translate=0&read=0&name=" + encodeURIComponent(file.name), { method: "POST", body: file });
      st.attach = { id: r.id, title: file.name.replace(/\.pdf$/i, ""), fresh: !!r.new };
      if (PR.lib && PR.lib.load) PR.lib.load();
    } catch (e) {
      st.attach = { title: file.name, error: PR.t("没能加入文献库：{msg}", { msg: PR.errorText ? PR.errorText(e) : e.message }) };
    }
    render();
    const i = PR.$("#askInput");
    if (i) { i.focus(); if (!i.value) i.placeholder = PR.t("问这篇论文，例如：研究架构是什么？用了哪些量表？"); }
  }
  /* 现在这一问要带哪篇。st.attach：null 沿用这个对话附过的；{id…} 刚附上的；false 这次拿掉了 */
  const attached = () => (st.attach === false ? null : st.attach && st.attach.id ? st.attach : (thread() && thread().paper) || null);
  function attachHtml() {
    const a = st.attach && !st.attach.id ? st.attach : attached();
    if (!a) return "";
    if (a.uploading) return '<div class="ask-attach"><span class="spin"></span><span class="nm">' + PR.esc(a.title) + "</span><small>" + PR.t("正在加入文献库…") + "</small></div>";
    if (a.error) return '<div class="ask-attach bad"><span class="nm">' + PR.esc(a.error) + '</span><button class="x" data-a="detach" title="' + PR.t("移除") + '">' + PR.icon("x", "sm") + "</button></div>";
    return '<div class="ask-attach">' + PR.icon("note", "sm") + '<span class="nm" title="' + PR.esc(a.title) + '">' + PR.esc(a.title) + "</span>" +
      '<button class="lnk" data-a="open-paper" data-id="' + PR.esc(a.id) + '">' + PR.t("打开阅读") + "</button>" +
      '<button class="x" data-a="detach" title="' + PR.t("这一问不带这篇论文") + '">' + PR.icon("x", "sm") + "</button></div>";
  }

  function emptyHtml() {
    if (!st.loaded) return '<div class="ask-empty">' + (st.error ? PR.esc(st.error) : '<span class="spin"></span>') + "</div>";
    if (!st.models.length) {
      return '<div class="ask-empty"><p><b>' + PR.t("还没有用 API Key 的模型") + "</b></p><p>" +
        PR.t("这里的问题用你自己买的 API 额度回答。到设置 → 模型，加一个 OpenAI、Anthropic、Gemini 等服务商的模型并填好 Key，就能在这里用。") +
        '</p><button class="btn accent" data-a="settings">' + PR.t("去设置模型") + "</button></div>";
    }
    return '<div class="ask-empty"><p>' + PR.t("还没打开论文也能问：术语的中文译名、某个构面属于哪个理论、两个概念的差别……") + "</p><p>" +
      PR.t("也可以按 📎 或把 PDF 拖进来，直接问这篇论文。") + '</p><div class="ask-examples">' +
      EXAMPLES.map((q, i) => '<button class="ask-example" data-a="example" data-i="' + i + '">' + PR.esc(PR.t(q)) + "</button>").join("") + "</div></div>";
  }

  function render() {
    const t = thread();
    const m = modelOf(st.model);
    const options = st.models.map((x) => '<option value="' + PR.esc(x.id) + '"' + (x.id === st.model ? " selected" : "") + (x.ready ? "" : " disabled") + ">" +
      PR.esc(x.label + " · " + x.source + (x.ready ? "" : PR.t("（没填 Key）"))) + "</option>").join("");
    const list = st.listOpen ? '<div class="ask-list">' + '<button class="ask-thread newt" data-a="new">' + PR.t("＋ 新对话") + "</button>" +
      (st.threads.length ? st.threads.map((x) => '<div class="ask-thread' + (x.id === st.cur ? " on" : "") + '" data-a="open" data-t="' + PR.esc(x.id) + '"><div class="tt">' + PR.esc(x.title || PR.t("（无标题）")) + '</div><div class="tm">' + PR.esc(PR.shortTime(x.updated)) + '</div><button class="tx" data-a="del" data-t="' + PR.esc(x.id) + '" title="' + PR.t("删除") + '">' + PR.icon("trash", "sm") + "</button></div>").join("")
        : '<div class="ask-none">' + PR.t("还没有对话") + "</div>") + "</div>" : "";
    const busy = !!st.streaming;
    panel.innerHTML =
      '<div class="ask-head"><button class="ask-title" data-a="list" title="' + PR.t("对话记录") + '">' + PR.icon("sparkle", "sm") + "<span>" + PR.esc(t ? t.title : PR.t("问 AI")) + "</span>" + PR.icon("chevron", "sm") + "</button>" +
      '<span class="grow"></span><button class="btn icon" data-a="new" title="' + PR.t("新对话") + '">' + PR.icon("plus") + '</button><button class="btn icon" data-a="close" title="' + PR.t("关闭") + '">' + PR.icon("x") + "</button>" + list + "</div>" +
      '<div class="ask-scroll" id="askScroll">' + (t && t.messages.length ? t.messages.map(messageHtml).join("") : emptyHtml()) + "</div>" +
      (st.models.length ? '<div class="ask-foot">' + attachHtml() + '<div class="ask-input"><button class="ask-clip" data-a="attach" title="' + PR.t("附上 PDF（会加入文献库，不翻译）") + '"' + (busy ? " disabled" : "") + ">" + PR.icon("link", "sm") + '</button><textarea id="askInput" rows="2" placeholder="' + PR.esc(PR.t("问一个问题，Enter 发送，Shift+Enter 换行")) + '"' + (busy ? " disabled" : "") + "></textarea>" +
        (busy ? '<button class="ask-send stop" data-a="stop" title="' + PR.t("停止") + '">' + PR.icon("stop") + "</button>"
          : '<button class="ask-send" data-a="send" title="' + PR.t("发送") + '"' + (m && m.ready ? "" : " disabled") + ">" + PR.icon("arrowUp") + "</button>") + "</div>" +
        '<div class="ask-opts"><select id="askModel" class="input" aria-label="' + PR.t("模型") + '"' + (busy ? " disabled" : "") + ">" + options + "</select>" +
        '<label class="ask-gloss"><input type="checkbox" id="askGloss"' + (st.glossary ? " checked" : "") + "> " + PR.t("参考文献库译名") + "</label></div>" +
        '<div class="ask-note">' + PR.t("用你在设置里填的 API Key，按该服务商的价格计费。AI 可能出错，术语译名请再查证。") + "</div></div>" : "");
    if (m && !m.ready && m.hint && PR.$("#askInput")) PR.$("#askInput").placeholder = m.hint;
    const sc = PR.$("#askScroll");
    if (sc) sc.scrollTop = sc.scrollHeight;
  }

  async function send(text) {
    text = (text || "").trim();
    if (!text || st.streaming) return;
    let t = thread();
    if (!t) { t = { id: null, title: text.slice(0, 40), messages: [], local: true }; st.threads.unshift(t); }
    const att = attached();
    if (st.attach && st.attach.uploading) return PR.toast(PR.t("论文还在加入文献库，稍等一下再问"));
    const user = { role: "user", content: text };
    const msg = { role: "assistant", content: "", model: (modelOf(st.model) || {}).label };
    t.messages.push(user, msg);
    const ctrl = new AbortController();
    st.streaming = { ctrl, msg };
    st.cur = t.id; st.listOpen = false;
    render();
    try {
      const res = await fetch("/api/ask", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ thread: t.local ? null : t.id, text, model: st.model, use_glossary: st.glossary, paper: att ? att.id : "", paper_title: att ? att.title : "" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.thread && (t.local || !t.id)) { t.id = ev.thread; delete t.local; st.cur = t.id; }
          if (ev.model) msg.model = ev.model;
          if (ev.glossary) msg.glossary = ev.glossary;
          if (ev.paper) { msg.paper = ev.paper; t.paper = { id: ev.paper.id, title: ev.paper.title }; }
          if (ev.t) { msg.content += ev.t; renderSoon(); }
          if (ev.done && ev.usage) msg.usage = ev.usage;
          if (ev.error) msg.error = PR.t("没能回答：{msg}", { msg: ev.error });
        }
      }
    } catch (e) {
      if (e.name === "AbortError") msg.content += "\n\n" + PR.t("（已停止）");
      else msg.error = PR.t("没能回答：{msg}", { msg: PR.errorText ? PR.errorText(e) : e.message });
    }
    st.streaming = null;
    if (att && !msg.error) st.attach = null;  // 已经记在对话上了（thread.paper），附件栏改显示对话的那篇
    else if (!att && st.attach === false) { delete t.paper; st.attach = null; }
    if (!t.id) { t.id = "local-" + Date.now(); st.cur = t.id; }
    t.updated = PR.nowIso();
    render();
    const input = PR.$("#askInput");
    if (input) input.focus();
  }
  const renderSoon = PR.debounce ? PR.debounce(render, 40) : render;

  PR.toggleAsk = function (force) {
    st.open = force != null ? force : !st.open;
    document.body.classList.toggle("ask-open", st.open);
    panel.setAttribute("aria-hidden", String(!st.open));
    const btn = PR.$("#askBtn");
    if (btn) btn.classList.toggle("on", st.open);
    if (st.open) {
      if (!st.loaded) load(); else render();
      setTimeout(() => { const i = PR.$("#askInput"); if (i) i.focus(); }, 60);
    }
  };

  panel.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]");
    if (!b) { if (st.listOpen && !e.target.closest(".ask-list")) { st.listOpen = false; render(); } return; }
    const a = b.dataset.a;
    if (a === "close") return PR.toggleAsk(false);
    if (a === "list") { st.listOpen = !st.listOpen; return render(); }
    if (a === "new") { if (st.streaming) return; st.cur = null; st.attach = null; st.listOpen = false; render(); const i = PR.$("#askInput"); return i && i.focus(); }
    if (a === "attach") return fileInput.click();
    if (a === "detach") { st.attach = false; return render(); }
    if (a === "open-paper") return PR.lib && PR.lib.openReader ? PR.lib.openReader(b.dataset.id) : (location.href = "/read/" + b.dataset.id);
    if (a === "settings") { PR.toggleAsk(false); return PR.openSettings && PR.openSettings(); }
    if (a === "example") return send(PR.t(EXAMPLES[+b.dataset.i]));
    if (a === "send") return send((PR.$("#askInput") || {}).value);
    if (a === "stop") return st.streaming && st.streaming.ctrl.abort();
    if (a === "del") {
      e.stopPropagation();
      const id = b.dataset.t;
      if (id.startsWith("local-")) st.threads = st.threads.filter((x) => x.id !== id);
      else st.threads = (await PR.api("/api/ask/delete", { method: "POST", body: { thread: id } })).threads || [];
      if (st.cur === id) st.cur = null;
      return render();
    }
    if (a === "open") {
      const id = b.dataset.t;
      if (!id.startsWith("local-")) {  // 别处问过的也看得到：重新取一次记录
        const r = await PR.api("/api/ask").catch(() => null);
        if (r) st.threads = r.threads || st.threads;
      }
      st.cur = id; st.listOpen = false; st.attach = null;
      const t = thread();
      if (t && modelOf(t.model) && modelOf(t.model).ready) st.model = t.model;
      return render();
    }
  });
  panel.addEventListener("change", (e) => {
    if (e.target.id === "askModel") st.model = e.target.value;
    if (e.target.id === "askGloss") st.glossary = e.target.checked;
  });
  panel.addEventListener("keydown", (e) => {
    if (e.target.id === "askInput" && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.target.value); }
    if (e.key === "Escape") PR.toggleAsk(false);
  });
  // 把 PDF 拖进面板：附到这次的问题上（拖到面板外面还是照常导入）
  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes("Files");
  panel.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); panel.classList.add("drop"); document.body.classList.add("ask-drop"); });
  panel.addEventListener("dragleave", (e) => { if (!panel.contains(e.relatedTarget)) { panel.classList.remove("drop"); document.body.classList.remove("ask-drop"); } });
  panel.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();  // 不要让文献库的拖放导入（会照设置开始翻译）也接到
    panel.classList.remove("drop"); document.body.classList.remove("ask-drop");
    if (PR.resetDropOverlay) PR.resetDropOverlay();
    const f = Array.from(e.dataTransfer.files || [])[0];
    if (f && !st.streaming) attachFile(f);
  });
  PR.askAbout = function (id, title) {  // 文献库别处要“问这篇”时用
    st.cur = null; st.attach = { id, title: title || id };
    PR.toggleAsk(true);
  };

  // 设置里改了模型或 Key，下次打开重新取
  PR.on("settings-saved", () => { st.loaded = false; if (st.open) load(); });

  const btn = PR.$("#askBtn");
  if (btn) {
    btn.innerHTML = PR.icon("sparkle", "sm") + "<span>" + PR.t("问 AI") + "</span>";
    btn.title = PR.t("不用打开论文，直接问 AI（用你自己的 API Key）");
    btn.onclick = () => PR.toggleAsk();
  }
})(window.PR);
