// 逐句对照：顶栏“逐句”和 B 键切换、句子交替排列（只调 order，不动 DOM）
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function el(cls, kids = [], attrs = {}) {
  const node = {
    classList: {
      set: new Set(cls.split(" ").filter(Boolean)),
      contains(c) { return this.set.has(c); }, add(...c) { c.forEach((x) => this.set.add(x)); },
      remove(...c) { c.forEach((x) => this.set.delete(x)); }, toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); },
    },
    children: kids, dataset: attrs, style: {}, parentElement: null,
    querySelector(sel) { return sel === ".snt" ? (kids.find((k) => k.classList.contains("snt")) || null) : null; },
  };
  kids.forEach((k) => (k.parentElement = node));
  return node;
}

function setup(mode = "zh", biOrder = "translation", zhCount = 2, enCount = 2) {
  const sents = (n) => Array.from({ length: n }, (_, i) => el("snt", [], { s: String(i) }));
  const zh = el("zh", sents(zhCount), { key: "p1" });
  const en = el("en", sents(enCount));
  const blk = el("blk", [zh, en]);
  const bodyClasses = new Set();
  const PR = {
    state: { paper: { meta: {}, blocks: [] } },
    prefs: { mode, lead: "translation", biOrder },
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s),
    esc: String, el: () => ({ classList: { contains: () => false, toggle() {} }, addEventListener() {} }),
    targetName: () => "繁體中文", icon: () => "", on() {}, titleHtml: String,
    enOfZh: (z) => (z === zh ? en : null),
    $: () => null,
    $$: (sel, scope) => {
      if (sel === "#paper .sent-pairs") return blk.classList.contains("sent-pairs") ? [blk] : [];
      if (sel === "#paper .zh[data-key]") return [zh];
      if (sel === ".snt") return zh.children.concat(en.children);
      if (sel === ":scope > .snt") return scope.children.filter((c) => c.classList.contains("snt"));
      return [];
    },
  };
  PR.setPref = (k, v) => { PR.prefs[k] = v; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/reading-language.js"), "utf8"), {
    window: { PR },
    document: { body: { append() {}, classList: { toggle: (c, on) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)) } }, addEventListener() {}, createElement: () => ({}) },
    innerWidth: 1200,
  });
  return { PR, zh, en, blk, bodyClasses };
}

test("the view switch maps sentence mode to its own preference", () => {
  const { PR } = setup();
  PR.setView("sentence");
  assert.equal(PR.prefs.mode, "sent");
  assert.equal(PR.readingView(), "sentence");
  assert.equal(PR.isBilingual(), true);
  PR.setBiOrder("original");
  assert.equal(PR.prefs.mode, "sent", "changing the order keeps sentence mode");
  assert.equal(PR.originalFirst(), true);
  PR.setView("both");
  assert.equal(PR.prefs.mode, "bi");
});

test("aligned sentences alternate, translation first by default", () => {
  const { PR, zh, en, blk, bodyClasses } = setup("sent");
  PR.applySentencePairs();
  assert.ok(bodyClasses.has("mode-sent"));
  assert.ok(blk.classList.contains("sent-pairs"));
  assert.deepEqual(zh.children.map((n) => n.style.order), ["0", "2"]);
  assert.deepEqual(en.children.map((n) => n.style.order), ["1", "3"]);
});

test("original first puts each English sentence before its translation", () => {
  const { PR, zh, en } = setup("sent", "original");
  PR.applySentencePairs();
  assert.deepEqual(en.children.map((n) => n.style.order), ["0", "2"]);
  assert.deepEqual(zh.children.map((n) => n.style.order), ["1", "3"]);
});

test("paragraphs whose sentences do not line up stay as whole paragraphs", () => {
  const { PR, blk } = setup("sent", "translation", 3, 2);
  PR.applySentencePairs();
  assert.equal(blk.classList.contains("sent-pairs"), false);
});

test("leaving sentence mode clears the ordering", () => {
  const { PR, zh, blk, bodyClasses } = setup("sent");
  PR.applySentencePairs();
  PR.prefs.mode = "bi";
  PR.applySentencePairs();
  assert.equal(bodyClasses.has("mode-sent"), false);
  assert.equal(blk.classList.contains("sent-pairs"), false);
  assert.deepEqual(zh.children.map((n) => n.style.order), ["", ""]);
});
