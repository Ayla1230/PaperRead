/* 首页翻卡时钟：标题右边一个翻卡式的时:分，旁边小字写日期和星期；分钟变了才翻。 */
(function () {
  const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((d) => PR.t(d));
  function digit() {
    const d = document.createElement("span"); d.className = "fc-d";
    d.innerHTML = '<span class="h t"><span></span></span><span class="h b"><span></span></span><span class="h t flap"><span></span></span><span class="h b flap2"><span></span></span>';
    d.val = null; return d;
  }
  function set(d, v) {
    if (d.val === v) return;
    const [t, b, f, f2] = d.querySelectorAll(".h");
    const old = d.val == null ? v : d.val; d.val = v;
    t.firstChild.textContent = v; f.firstChild.textContent = old; b.firstChild.textContent = old; f2.firstChild.textContent = v;
    d.classList.remove("go"); void d.offsetWidth; d.classList.add("go");
    clearTimeout(d.tm); d.tm = setTimeout(() => { b.firstChild.textContent = v; f.firstChild.textContent = v; d.classList.remove("go"); }, 620);
  }
  const box = document.createElement("span"); box.className = "flipclock"; box.title = PR.t("今天日期与时间");
  const ts = [];
  const g1 = document.createElement("span"); g1.className = "grp";
  const g2 = document.createElement("span"); g2.className = "grp";
  for (let i = 0; i < 4; i++) ts.push(digit());
  const sep = (c) => { const s = document.createElement("span"); s.className = "sep"; s.textContent = c; return s; };
  const wd = document.createElement("span"); wd.className = "wd"; g1.append(wd);
  g2.append(ts[0], ts[1], sep(":"), ts[2], ts[3]);
  box.append(g2, g1);
  const head = document.querySelector(".list-head h1"); if (!head) return; head.after(box);
  function tick() {
    const n = new Date(), p = (x) => String(x).padStart(2, "0");
    const b = p(n.getHours()) + p(n.getMinutes());
    [...b].forEach((c, i) => set(ts[i], c)); wd.textContent = (n.getMonth() + 1) + "/" + n.getDate() + " " + WD[n.getDay()];
  }
  tick(); setInterval(tick, 1000);
})();
