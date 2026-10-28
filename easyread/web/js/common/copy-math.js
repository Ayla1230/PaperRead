/* 复制给 Word 用：公式不再贴出 LaTeX 原始码（$\mathrm{H_2SO_4}$、mg_{Pt}^{-1}），而是转成 Word 看得懂的样子。
   - 富文本（text/html）：上下标用 <sub>/<sup>，贴进 Word、Google 文件、Pages 都保留格式；
   - 纯文本（text/plain）：能用 Unicode 上下标字元的就用（H₂SO₄、cm⁻²），不能的写成 x_(ij)、x^(n+1)。
   三个入口：在正文、问 AI、首页问 AI 里选取文字按 Ctrl/⌘+C；选取工具列的“复制”；段落选单和 AI 回答的“复制”。 */
(function (PR) {
  "use strict";

  const SYM = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
    iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς",
    tau: "τ", upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", ne: "≠", approx: "≈",
    sim: "∼", simeq: "≃", equiv: "≡", propto: "∝", infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫",
    to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
    uparrow: "↑", downarrow: "↓", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", forall: "∀", exists: "∃",
    circ: "∘", degree: "°", ell: "ℓ", hbar: "ℏ", AA: "Å", ldots: "…", cdots: "⋯", dots: "…", prime: "′", parallel: "∥", mid: "|",
    langle: "⟨", rangle: "⟩", lvert: "|", rvert: "|", vert: "|", Vert: "‖", "|": "‖", lbrace: "{", rbrace: "}",
    "%": "%", "$": "$", "&": "&", "#": "#", "_": "_", "{": "{", "}": "}",
    ",": " ", ";": " ", ":": " ", " ": " ", quad: " ", qquad: "  ", "!": "", "\\": " ", newline: " ",
    left: "", right: "", big: "", Big: "", bigg: "", Bigg: "", displaystyle: "", textstyle: "", limits: "", nolimits: "",
    log: "log", ln: "ln", exp: "exp", sin: "sin", cos: "cos", tan: "tan", max: "max", min: "min", lim: "lim", det: "det", Pr: "Pr",
  };
  const BB = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", E: "𝔼", P: "ℙ" };
  const ACCENT = { hat: "̂", widehat: "̂", bar: "̄", overline: "̅", tilde: "̃", widetilde: "̃", dot: "̇", ddot: "̈", vec: "⃗" };
  const PLAIN = new Set(["mathrm", "text", "textrm", "textnormal", "mathbf", "textbf", "mathit", "textit", "mathsf", "mathtt", "operatorname", "boldsymbol", "bm", "mbox"]);
  const SUP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", T: "ᵀ", "*": "*", "′": "′" };
  const SUB = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
    a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* ---------- TeX → {html, text} ---------- */
  function tokenize(src) {
    const out = [];
    for (let i = 0; i < src.length;) {
      const c = src[i];
      if (c === "\\") {
        const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
        if (!m) { i++; continue; }
        out.push({ cmd: m[1] });
        i += m[0].length;
        if (/^[A-Za-z]/.test(m[1])) while (src[i] === " ") i++;  // 命令后面的空格不算
      } else if (c === "{" || c === "}" || c === "^" || c === "_") { out.push({ op: c }); i++; }
      else { out.push({ ch: c }); i++; }
    }
    return out;
  }
  function parse(tokens, pos, stopAtBrace, keepSpace) {
    const nodes = [];
    while (pos.i < tokens.length) {
      const t = tokens[pos.i];
      if (t.op === "}") { if (stopAtBrace) { pos.i++; break; } pos.i++; continue; }
      if (t.op === "{") { pos.i++; nodes.push({ group: parse(tokens, pos, true, keepSpace) }); continue; }
      if (t.op === "^" || t.op === "_") { pos.i++; nodes.push({ script: t.op, arg: arg(tokens, pos, keepSpace) }); continue; }
      pos.i++;
      if (t.ch != null) {
        if (t.ch === " " && !keepSpace) continue;
        let ch = t.ch === "~" || t.ch === "&" ? " " : t.ch;
        if (!keepSpace) ch = ch === "-" ? "−" : /[=<>]/.test(ch) ? " " + ch + " " : ch === "," ? ", " : ch;  // 数学式里的减号、关系符号前后留空
        nodes.push({ text: ch });
        continue;
      }
      const c = t.cmd;
      if (PLAIN.has(c)) { nodes.push({ group: argNodes(tokens, pos, c.startsWith("text") || c === "mbox"), bold: /bf|bold|bm/.test(c) }); continue; }
      if (c === "mathbb") { const a = flatText(argNodes(tokens, pos)); nodes.push({ text: [...a].map((x) => BB[x] || x).join("") }); continue; }
      if (c === "frac" || c === "dfrac" || c === "tfrac") { nodes.push({ frac: [argNodes(tokens, pos), argNodes(tokens, pos)] }); continue; }
      if (c === "sqrt") { nodes.push({ sqrt: argNodes(tokens, pos) }); continue; }
      if (ACCENT[c]) { nodes.push({ accent: ACCENT[c], arg: argNodes(tokens, pos) }); continue; }
      if (c === "begin" || c === "end") { argNodes(tokens, pos); continue; }
      if (c in SYM) {
        const rel = /^(times|pm|mp|le|leq|ge|geq|neq|ne|approx|sim|simeq|equiv|propto|to|rightarrow|leftarrow|leftrightarrow|Rightarrow|Leftarrow|Leftrightarrow|in|notin|subset|subseteq)$/.test(c);
        nodes.push({ text: rel && !keepSpace ? " " + SYM[c] + " " : SYM[c] });
        continue;
      }
      nodes.push({ text: c });  // 不认识的命令：留下名字，总比一串反斜线好读
    }
    return nodes;
  }
  function argNodes(tokens, pos, keepSpace) {
    while (pos.i < tokens.length && tokens[pos.i].ch === " ") pos.i++;
    const t = tokens[pos.i];
    if (!t) return [];
    if (t.op === "{") { pos.i++; return parse(tokens, pos, true, keepSpace); }
    pos.i++;
    if (t.cmd) { const sub = parse([t], { i: 0 }, false, keepSpace); return sub; }
    return t.ch != null ? [{ text: t.ch }] : [];
  }
  const arg = (tokens, pos, keepSpace) => argNodes(tokens, pos, keepSpace);
  function flatText(nodes) { return nodes.map((n) => n.text != null ? n.text : n.group ? flatText(n.group) : "").join(""); }

  function render(nodes) {  // → {html, text}
    let html = "", text = "";
    for (const n of nodes) {
      if (n.text != null) { html += esc(n.text); text += n.text; continue; }
      if (n.group) { const r = render(n.group); html += n.bold ? "<b>" + r.html + "</b>" : r.html; text += r.text; continue; }
      if (n.frac) {
        const a = render(n.frac[0]), b = render(n.frac[1]);
        const wrap = (r) => (/^[\w.]+$/.test(r.text) ? r : { html: "(" + r.html + ")", text: "(" + r.text + ")" });
        const A = wrap(a), B = wrap(b);
        html += A.html + "/" + B.html; text += A.text + "/" + B.text; continue;
      }
      if (n.sqrt) { const r = render(n.sqrt); const one = r.text.length === 1; html += "√" + (one ? r.html : "(" + r.html + ")"); text += "√" + (one ? r.text : "(" + r.text + ")"); continue; }
      if (n.accent) { const r = render(n.arg); const mark = (s) => [...s].map((ch) => ch + n.accent).join(""); html += n.arg.length === 1 && n.arg[0].text ? esc(mark(n.arg[0].text)) : mark(r.html); text += mark(r.text); continue; }
      if (n.script) {
        const r0 = render(n.arg), map = n.script === "^" ? SUP : SUB;
        const r = { html: r0.html.trim().replace(/ ([=<>,]|&lt;|&gt;) ?/g, "$1"), text: r0.text.trim().replace(/ ?([=<>,≤≥≠≈]) ?/g, "$1") };  // 上下标里不留空
        html += (n.script === "^" ? "<sup>" : "<sub>") + r.html + (n.script === "^" ? "</sup>" : "</sub>");
        const chars = [...r.text];
        text += chars.length && chars.every((ch) => map[ch]) ? chars.map((ch) => map[ch]).join("")
          : (n.script === "^" ? "^" : "_") + (chars.length > 1 ? "(" + r.text + ")" : r.text);
      }
    }
    return { html, text };
  }
  /* 对外：一段 TeX 转成 Word 能用的 {html, text}。先用 fixTex 修掉模型常见的错误写法 */
  PR.texToWord = function (tex) {
    const src = PR.fixTex ? PR.fixTex(String(tex || "")) : String(tex || "");
    try {
      const r = render(parse(tokenize(src), { i: 0 }, false, false));
      return { html: r.html.replace(/\s+/g, " ").trim(), text: r.text.replace(/\s+/g, " ").trim() };
    } catch (e) {
      return { html: esc(tex), text: String(tex) };
    }
  };

  /* ---------- 把一块已经排好的 HTML（里面有 KaTeX）转成 Word 用的 html / 纯文字 ---------- */
  function texOf(katex) {
    const ann = katex.querySelector('annotation[encoding="application/x-tex"]');
    return ann ? ann.textContent : "";
  }
  function convert(root) {
    const plainRoot = root.cloneNode(true);
    const swap = (r, plain) => {
      PR.$$(".katex-display, .katex", r).forEach((k) => {
        if (!k.isConnected && k.parentNode == null) return;
        if (k.classList.contains("katex") && k.closest(".katex-display") && k.closest(".katex-display") !== k) return;
        const tex = texOf(k);
        const w = PR.texToWord(tex);
        const display = k.classList.contains("katex-display");
        let node;
        if (plain) node = document.createTextNode(w.text);
        else { node = document.createElement(display ? "p" : "span"); node.innerHTML = w.html; if (display) node.style.textAlign = "center"; }
        k.replaceWith(node);
      });
      PR.$$(".katex-mathml, .stale-tag, .note-pin, .inline-notes, button, .pgmark, .edited-dot", r).forEach((n) => n.remove());
    };
    swap(root, false);
    swap(plainRoot, true);
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-99999px;top:0;width:800px;white-space:normal";
    holder.append(plainRoot);
    document.body.append(holder);
    const text = holder.innerText.replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
    holder.remove();
    return { html: root.innerHTML, text };
  }
  /* 选取范围的两端落在公式里时，扩到整个公式（不然只复制到公式的一半排版） */
  function wholeMath(range) {
    const r = range.cloneRange();
    const up = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest(".katex-display, .katex");
    const a = up(r.startContainer), b = up(r.endContainer);
    if (a) r.setStartBefore(a.closest(".katex-display") || a);
    if (b) r.setEndAfter(b.closest(".katex-display") || b);
    return r;
  }
  PR.rangeForWord = function (range) {
    const box = document.createElement("div");
    box.append(wholeMath(range).cloneContents());
    return convert(box);
  };
  /* Markdown（带 $公式$）→ Word 用的 html / 纯文字：先排版，再转 */
  PR.markdownForWord = function (md, blocks) {
    const box = document.createElement("div");
    box.innerHTML = blocks ? PR.mdBlocks(md || "") : PR.md(md || "");
    return convert(box);
  };
  async function write(data) {
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([data.html], { type: "text/html" }), "text/plain": new Blob([data.text], { type: "text/plain" }) })]);
        return;
      }
    } catch (e) { /* 有的浏览器不让写富文本：退回纯文字 */ }
    await navigator.clipboard.writeText(data.text);
  }
  PR.copyForWord = (md, blocks) => write(PR.markdownForWord(md, blocks));
  PR.copyRangeForWord = (range) => write(PR.rangeForWord(range));

  /* Ctrl/⌘+C：选取里有公式时接手，其余照浏览器原本的复制 */
  document.addEventListener("copy", (e) => {
    const sel = getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed || !e.clipboardData) return;
    const range = sel.getRangeAt(0);
    const host = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (host && host.closest("input, textarea, [contenteditable]")) return;
    const inMath = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest(".katex");
    const box = document.createElement("div");
    box.append(range.cloneContents());
    if (!box.querySelector(".katex") && !inMath(range.startContainer) && !inMath(range.endContainer)) return;
    const data = PR.rangeForWord(range);
    e.clipboardData.setData("text/html", data.html);
    e.clipboardData.setData("text/plain", data.text);
    e.preventDefault();
  });
})(window.PR);
