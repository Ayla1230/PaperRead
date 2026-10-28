// 复制到 Word：公式转成上下标（HTML 用 <sub>/<sup>，纯文字用 Unicode 上下标），不贴 LaTeX 原始码
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function load() {
  const ctx = { window: {}, console, document: { addEventListener() {} } };
  vm.createContext(ctx);
  ctx.window.PR = { t: (s) => s, esc: String, on() {} };
  for (const f of ["markup.js", "copy-math.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common", f), "utf8"), ctx);
  return ctx.window.PR;
}

test("chemical formula and unit become real sub/superscripts", () => {
  const PR = load();
  const a = PR.texToWord("0.5\\text{ M H_2SO_4}");
  assert.equal(a.text, "0.5 M H₂SO₄");
  assert.match(a.html, /H<sub>2<\/sub>SO<sub>4<\/sub>/);
  const b = PR.texToWord("2.16\\text{ A mg_{Pt}}^{-1}");
  assert.match(b.html, /mg<sub>Pt<\/sub><sup>−1<\/sup>/);
  assert.match(b.text, /⁻¹$/);
});

test("statistics read naturally without backslashes", () => {
  const PR = load();
  assert.equal(PR.texToWord("R^2 = 0.43, p < .001").text, "R² = 0.43, p < .001");
  const reg = PR.texToWord("\\hat{\\beta}_1 = \\frac{\\sum (x_i-\\bar{x})(y_i-\\bar{y})}{\\sum (x_i-\\bar{x})^2}").text;
  assert.doesNotMatch(reg, /\\/);
  assert.match(reg, /β/);
});
