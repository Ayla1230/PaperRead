const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function render(blocks) {
  const paperEl = { innerHTML: "" };
  const bodyClass = new Set();
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
    titleOf: (m) => m.title_en || "",
    state: {
      paper: { meta: { title_en: "Table test", pages: [{ n: 1, img: "pages/page-001.webp" }] }, translation: { done_pages: [1] }, blocks },
      reader: { edits: {} },
      discussion: { entries: [] },
      layout: {},
      item: {},
      job: {},
    },
    $: (sel) => sel === "#paper" ? paperEl : null,
    $$: () => [],
    esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    md: (s) => String(s == null ? "" : s),
    plain: (s) => String(s == null ? "" : s),
    textFor: (key) => {
      const [id, field] = String(key).split("#");
      const b = blocks.find(x => x.id === id) || {};
      return field === "caption" ? (b.caption_zh || b.caption_en || "") : (b.zh || b.en || "");
    },
    agentText: (key) => PR.textFor(key),
    editOf: () => null,
    isEnKey: () => false,
    hasZh: (b) => !!(b && (b.zh || b.caption_zh)),
    blockKeys: (b) => b.type === "table" || b.type === "figure" ? [b.id + "#caption"] : [b.id],
    imageUrl: (rel) => rel,
    canAsk: () => false,
    store: { mode: "file" },
    usageShort: () => "",
    emit() {},
    on() {},
    fitWide() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/render.js"), "utf8"), {
    window: { PR },
    document: {
      documentElement: { dataset: {} },
      body: { classList: { toggle() {} } },
      getElementById: () => null,
      createElement: () => ({ innerHTML: "", firstChild: null, classList: { contains: () => false, add() {} }, querySelector: () => null }),
    },
    console,
  });
  PR.renderPaper();
  return paperEl.innerHTML;
}

test("translated tables render as a real table next to the text, with a link to the original page", () => {
  const html = render([
    { id: "tab1", type: "table", page: 1, head: ["Method", "Score"], rows: [["A", "0.8"]], caption_zh: "表 1：結果" },
    { id: "p1", type: "para", page: 1, zh: "AFTER_TABLE" },
  ]);
  assert.match(html, /<thead><tr><th[^>]*>Method<\/th><th[^>]*>Score<\/th><\/tr><\/thead>/);
  assert.match(html, /<td[^>]*>0\.8<\/td>/);
  assert.match(html, /class="tbl-orig link" data-t="page"/);
  assert.match(html, /表 1<\/span>：結果/);
  assert.doesNotMatch(html, /fig-placeholder/);
  assert.match(html, /AFTER_TABLE/);
});

test("a table the model could not rebuild shows the original page image inline", () => {
  const html = render([{ id: "tab2", type: "table", page: 1, head: [], rows: [], caption_zh: "表 2：缺" }]);
  assert.match(html, /class="fig-page"><img data-t="page"[^>]*src="pages\/page-001\.webp"/);
  assert.doesNotMatch(html, /<table class="tbl"/);
});

test("one malformed block does not blank the rest of the reader", () => {
  const html = render([
    { id: "bad", type: "list", page: 1, items: "not-an-array" },
    { id: "p1", type: "para", page: 1, zh: "AFTER_MALFORMED_BLOCK" },
  ]);
  assert.match(html, /AFTER_MALFORMED_BLOCK/);
  assert.match(html, /bad/);
});

