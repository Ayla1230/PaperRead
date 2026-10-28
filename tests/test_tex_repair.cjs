// 公式修补：\text{} 里有下标上标时改成 \mathrm{}，免得整串变成红字原始码（使用者回报的 0.5\text{ M H_2SO_4}）
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function load() {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../easyread/web/vendor/katex/katex.min.js"), "utf8") + ";window.katex=katex;", ctx);
  ctx.katex = ctx.window.katex;
  ctx.window.PR = { t: (s) => s, esc: String, on() {} };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/markup.js"), "utf8"), ctx);
  return ctx.window.PR;
}

test("chemical formulas written inside \\text render instead of showing red source", () => {
  const PR = load();
  for (const tex of ["0.5\\text{ M H_2SO_4}", "2.16\\text{ A mg_{Pt}}^{-1}"]) {
    const html = PR.tex(tex, false);
    assert.doesNotMatch(html, /katex-error/, tex);
    assert.match(html, /class="katex"/);
  }
});

test("plain \\text without sub/superscripts is left untouched", () => {
  const PR = load();
  assert.equal(PR.fixTex("\\text{ mA cm}^{-2}"), "\\text{ mA cm}^{-2}");
});
