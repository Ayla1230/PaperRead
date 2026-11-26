/* 翻译版的图：每个译文标签的字级照它在图上的框调整（框的高度，直排的看宽度），太长就缩到放得下。
   图片载入、版面变宽变窄时重算。 */
(function (PR) {
  "use strict";
  function fit(span) {
    const w = span.clientWidth, h = span.clientHeight;
    if (!w || !h) return;
    const tall = span.classList.contains("tall");
    let f = Math.max(10, Math.min(28, (tall ? w : h) * 0.9));
    span.style.fontSize = f + "px";
    const over = tall ? span.scrollHeight / h : span.scrollWidth / w;
    if (over > 1.01) span.style.fontSize = Math.max(9, f / over * 0.97) + "px";
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
