const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function reader(block, edits = {}, pages = []) {
  let html = '';
  const node = { classList: { contains: () => false }, querySelector: () => null, replaceWith() {} };
  const PR = {
    state: { reader: { edits }, paper: { blocks: [block], meta: { pages } } },
    on() {}, emit() {}, esc: String, md: String, t: s => s, imageUrl: s => '/p/test/' + s, hashText: s => s,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../easyread/web/js/reader/render.js'), 'utf8'), {
    window: { PR }, document: {
      getElementById: () => node,
      createElement: () => ({ set innerHTML(value) { html = value; }, firstChild: {} }),
    },
  });
  PR.blockById[block.id] = block;
  PR.renderBlock(block.id);
  return { PR, html };
}

test('cropped figure shows the image and its in-figure text together with the translation', () => {
  const { PR, html } = reader({ id: 'fig1', type: 'figure', page: 1, src: 'figures/a.webp', image_en: 'Accuracy', image_zh: '準確率', caption_en: 'Figure 1' });
  assert.match(html, /<img src="\/p\/test\/figures\/a\.webp"/);
  assert.match(html, /figure-translation/);
  assert.match(html, /準確率/);
  assert.doesNotMatch(html, /fig-placeholder/);
  assert.deepEqual(Array.from(PR.blockKeys(PR.blockById.fig1)), ['fig1#caption', 'fig1#image']);
});

test('reader edits to in-figure text are shown', () => {
  const { html } = reader({ id: 'fig1', type: 'figure', page: 1, src: 'figures/a.webp', image_en: 'Accuracy', image_zh: 'translated', caption_en: 'Figure 1' }, {
    'fig1#image': { zh: 'my wording', base: 'translated' },
  });
  assert.match(html, /my wording/);
});

test('figure that has not been cropped yet shows the original page image inline', () => {
  const { html } = reader({ id: 'fig1', type: 'figure', page: 2, caption_zh: 'caption' }, {}, [{ n: 2, img: 'pages/page-002.webp' }]);
  assert.match(html, /class="fig-page"><img data-t="page"[^>]*src="\/p\/test\/pages\/page-002\.webp"/);
  assert.doesNotMatch(html, /figure-translation/);
});

test('without any page image the figure falls back to a button to the original page', () => {
  const { html } = reader({ id: 'fig1', type: 'figure', page: 3, caption_zh: 'caption' });
  assert.match(html, /class="fig-missing" data-t="page"/);
});
