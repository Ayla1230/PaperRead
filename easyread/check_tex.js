// 用页面同一份 KaTeX 检查 paper.json / discussion.json 里的全部 TeX。
// 输入（stdin）：[[位置, tex, 是否行间], ...]；每个出错的公式输出一行。
const katex = require(process.argv[2]);
// 阅读页会先把 \text{…_…} 这类写法改成 \mathrm（markup.js 的 PR.fixTex）再显示，这里用同一份修补：
// 页面显示得出来的公式就不算错，免得为了它让模型把整批 JSON 重写一遍（翻译慢一倍）
let fixTex = (t) => t;
try {
  const fs = require("fs"), path = require("path"), vm = require("vm");
  const ctx = { window: { PR: { t: (s) => s, esc: String, on() {} } }, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "web/js/common/markup.js"), "utf8"), ctx);
  if (typeof ctx.window.PR.fixTex === "function") fixTex = ctx.window.PR.fixTex;
} catch (e) { /* 读不到 markup.js 就照原样检查 */ }
const renders = (tex, display) => {
  try { katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore" }); return null; } catch (e) { return e; }
};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let bad = 0;
  for (const [where, tex, display] of JSON.parse(input)) {
    const e = renders(tex, display);
    if (e && renders(fixTex(tex), display)) {
      bad++;
      console.log(`${where}：TeX 渲染失败 ${JSON.stringify(tex).slice(0, 80)} —— ${String(e.message).replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  process.exit(bad ? 1 : 0);
});
