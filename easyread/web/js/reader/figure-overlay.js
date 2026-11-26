/* 翻译版的图：每个译文标签的字级照它在图上的框调整（框的高度，直排的看宽度），太长就缩到放得下。
   图片载入、版面变宽变窄时重算。 */
(function (PR) {
  "use strict";
  function fit(span) {
    // 先回到原本的框（上次为了放下字撑大过）
    if (span.dataset.h === undefined) { span.dataset.h = span.style.height; span.dataset.w = span.style.width; }
    span.style.height = span.dataset.h; span.style.width = span.dataset.w; span.style.margin = "";
    const w = span.clientWidth, h = span.clientHeight;
    if (!w || !h) return;
    const tall = span.classList.contains("tall");
    let f = Math.max(10, Math.min(28, (tall ? w : h) * 0.85));
    span.style.fontSize = f + "px";
    const over = tall ? span.scrollHeight / h : span.scrollWidth / w;
    if (over > 1.01) span.style.fontSize = Math.max(9, f / over * 0.97) + "px";
    // 中文字比原本的英文框高（或直排时宽）就把白底撑开、置中盖住，不切掉字
    if (!tall && span.scrollHeight > h) { const d = span.scrollHeight - h + 2; span.style.height = h + d + "px"; span.style.marginTop = -d / 2 + "px"; }
    if (tall && span.scrollWidth > w) { const d = span.scrollWidth - w + 2; span.style.width = w + d + "px"; span.style.marginLeft = -d / 2 + "px"; }
  }
  const observer = window.ResizeObserver ? new ResizeObserver((entries) => entries.forEach((e) => e.target.querySelectorAll(".fl-ov").forEach(fit))) : null;
  function scan() {
    PR.$$(".fig-tr-in").forEach((box) => {
      if (box.dataset.fit) return;
      box.dataset.fit = "1";
      if (observer) observer.observe(box);
      const img = box.querySelector("img");
      const go = () => box.querySelectorAll(".fl-ov").forEach(fit);
      if (img && !img.complete) img.addEventListener("load", go, { once: true }); else go();
    });
  }
  const later = PR.debounce ? PR.debounce(scan, 50) : scan;
  PR.on("rendered", later);
  PR.on("block-rendered", later);
})(window.PR);
