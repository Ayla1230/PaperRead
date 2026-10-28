/* 首页顶栏的“用量”：用自己的 API Key 今天调用了多少次、多少 token，什么时候重置（版式学 Claude App 的“使用量”）。
   服务商没有接口能查剩余额度，次数是 PaperRead 自己记的；Gemini 的每日额度在太平洋时间午夜重置。
   使用者可以填每日上限（在 AI Studio 看得到），就会出现进度条；服务商回“今天额度用完”时直接标红。 */
(function (PR) {
  "use strict";
  const dlg = () => PR.$("#usageDlg");
  let data = null, timer = 0;

  const clock = (ts) => {
    const d = new Date(ts * 1000), hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    return (d.toDateString() === new Date().toDateString() ? PR.t("今天 {time}", { time: hm }) : PR.t("明天 {time}", { time: hm }));
  };
  const share = (r) => (r.exhausted ? 1 : r.limit ? Math.min(1, r.calls / r.limit) : null);
  const level = (x) => (x >= 0.95 ? "full" : x >= 0.8 ? "high" : "");

  function modelCard(p, r) {
    const x = share(r);
    const right = r.exhausted ? PR.t("今天的额度已用完") : r.limit ? PR.t("已使用 {pct}", { pct: Math.round(x * 100) + "%" }) : PR.t("今天 {n} 次", { n: r.calls });
    return '<div class="ud-card us-limit ' + (x == null ? "" : level(x)) + '">' +
      '<div class="us-row"><span class="ud-model">' + PR.esc(r.model) + "</span><em><b>" + right + "</b></em></div>" +
      (x == null ? "" : '<div class="us-bar"><i style="width:' + Math.max(x ? 1.5 : 0, x * 100) + '%"></i></div>') +
      '<div class="us-split">' + (r.limit ? PR.t("今天 {n} / {limit} 次", { n: r.calls, limit: r.limit }) : PR.t("今天 {n} 次", { n: r.calls })) +
      " · " + PR.t("输入 {n}", { n: PR.fmtTokens(r.input) }) + " · " + PR.t("输出 {n}", { n: PR.fmtTokens(r.output) }) + " token" + "</div>" +
      (r.exhausted ? '<div class="ud-warn">' + PR.t("服务商回复今天的免费额度已用完，{time} 重置后才能继续翻译。", { time: clock(p.reset_at) }) + "</div>" : "") +
      '<label class="ud-limit">' + PR.t("每日上限") + ' <input class="input" type="number" min="0" step="1" inputmode="numeric" placeholder="' + PR.t("未设") + '" value="' + (r.limit || "") +
      '" data-limit="' + PR.esc(p.id) + '" data-model="' + PR.esc(r.model) + '"> ' + PR.t("次") + "</label></div>";
  }

  function providerHtml(p) {
    const where = p.tz === "pacific" ? PR.t("每日额度在美国太平洋时间午夜重置，也就是本机时间 {time}", { time: clock(p.reset_at) }) : PR.t("按本机时间午夜计算“今天”");
    return '<section class="ud-prov"><div class="ud-head"><b>' + PR.esc(p.name) + "</b>" + (p.free ? '<span class="ud-tag">' + PR.t("有免费额度") + "</span>" : "") +
      "<em>" + PR.usageResetText(p.reset_at) + "</em></div>" + '<div class="us-split ud-sub">' + where + "</div>" +
      (p.models.length ? p.models.map((r) => modelCard(p, r)).join("") : '<div class="ud-card us-split">' + PR.t("今天还没有调用。") + "</div>") +
      (p.usage_url ? '<div class="us-foot">' + PR.t("Google 按整个项目计算额度，其他电脑或程序用同一个 Key 的次数这里看不到。") +
        ' <a href="' + p.usage_url + '" target="_blank" rel="noopener">' + PR.t("到 AI Studio 看实际额度 ↗") + "</a></div>" : "") + "</section>";
  }

  function render() {
    const provs = (data && data.providers) || [];
    const claude = data && data.claude && data.claude.limits ? PR.usageBars(data.claude.limits, "") : "";
    dlg().querySelector(".dialog").innerHTML = '<div class="ud-top"><h2>' + PR.t("用量") + '</h2><button class="btn sm line" data-u="refresh">' + PR.t("重新整理") + "</button></div>" +
      '<p class="hint">' + PR.t("用你自己的 API Key 调用模型的次数和 token，由 PaperRead 在这台电脑上记录。") + "</p>" +
      (provs.length ? provs.map(providerHtml).join("") : '<p class="ud-empty">' + PR.t("还没有用 API 调用过模型。翻译或问 AI 之后，这里会显示今天用了多少、什么时候重置。") + "</p>") +
      (claude ? '<section class="ud-prov"><div class="ud-head"><b>' + PR.t("Claude 订阅（Claude Code）") + '</b></div><div class="ud-card">' + claude + "</div></section>" : "") +
      '<div class="actions"><span class="grow"></span><button class="btn" data-u="close">' + PR.t("关闭") + "</button></div>";
  }

  /* 顶栏按钮：有设上限或已用完时直接显示百分比 */
  function button() {
    const btn = PR.$("#usageBtn");
    if (!btn) return;
    const rows = ((data && data.providers) || []).flatMap((p) => p.models);
    const top = rows.map(share).filter((x) => x != null).sort((a, b) => b - a)[0];
    btn.className = "btn line usage-btn " + (top == null ? "" : level(top));
    btn.innerHTML = PR.t("用量") + (top == null ? "" : " <b>" + Math.round(top * 100) + "%</b>");
    btn.title = PR.t("今天用了多少 API、什么时候重置");
  }

  async function load() {
    try { data = await PR.api("/api/usage"); } catch (e) { data = data || { providers: [] }; }
    button();
    if (dlg().classList.contains("open")) render();
  }

  async function open() {
    dlg().classList.add("open");
    render();
    await load();
    clearInterval(timer);
    timer = setInterval(() => (dlg().classList.contains("open") ? load() : clearInterval(timer)), 60000);
  }
  const close = () => { dlg().classList.remove("open"); clearInterval(timer); };
  PR.openUsage = open;

  PR.$("#usageBtn").onclick = open;
  dlg().addEventListener("click", (e) => {
    if (e.target === dlg()) return close();
    const b = e.target.closest("[data-u]");
    if (b && b.dataset.u === "close") close();
    if (b && b.dataset.u === "refresh") load();
  });
  dlg().addEventListener("change", async (e) => {
    const input = e.target.closest("[data-limit]");
    if (!input) return;
    try {
      data = await PR.api("/api/usage/limit", { method: "POST", body: { provider: input.dataset.limit, model: input.dataset.model, limit: input.value } });
      button(); render();
    } catch (err) { PR.toast(PR.esc(err.message)); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dlg().classList.contains("open")) close(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  load();
  setInterval(load, 5 * 60000);
})(window.PR);
