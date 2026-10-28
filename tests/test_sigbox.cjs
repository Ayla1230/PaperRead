// 显著性说明框：从段落里认出 p 值、星号和前面的系数，判断几 % 水准显著、方向正负
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function load() {
  const t = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m));
  const ctx = { window: {}, console, document: { addEventListener() {} } };
  vm.createContext(ctx);
  ctx.window.PR = { t, esc: String, on() {}, debounce: (f) => f, prefs: {}, state: { paper: { blocks: [] } } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/sigbox.js"), "utf8"), ctx);
  return ctx.window.PR;
}

test("p values with the coefficient before them", () => {
  const PR = load();
  const items = PR.sigItems("知覺行為控制正向影響採用意願（β = 0.32, p < .01），態度則不顯著（β = 0.05, p = .41）。");
  assert.equal(items.length, 2);
  assert.match(items[0].label, /β = 0.32, p < .01/);
  assert.match(items[0].text, /1% 水准下显著.*方向为正/);
  assert.equal(items[1].sig, false);
  assert.match(items[1].text, /不显著/);
});

test("TeX-written statistics and significance stars", () => {
  const PR = load();
  const items = PR.sigItems("結果顯示 $\\beta = -0.18$，$p < 0.001$；交互項係數為 0.25***，控制變數 0.03* 。");
  assert.match(items[0].label, /β = -0.18, p < 0.001/);
  assert.match(items[0].text, /0\.1% 水准.*方向为负/);
  assert.ok(items.some((x) => x.label === "0.25***" && /p < 0.001/.test(x.text)));
  assert.ok(items.some((x) => x.label === "0.03*" && /5% 水准/.test(x.text)));
});

test("paragraphs without statistics get no box; words like help= are not p values", () => {
  const PR = load();
  assert.equal(PR.sigItems("This study uses survey data from 312 farmers.").length, 0);
  assert.equal(PR.sigItems("help = 3 and group > 2").length, 0);
});
