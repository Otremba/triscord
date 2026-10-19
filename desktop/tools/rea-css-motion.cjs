// Lists every @keyframes block and every rule with transition/animation from Discord's CSS recovered from the
// Chromium cache, grouped by CSS module (class-name hash suffix), with source URL and SHA-256 of each file.
// Evidence for desktop/web motion; read-only text processing, never executes content, never copied into the app.
//
// Usage: node rea-css-motion.cjs <blocks-index.json> <blocks-dir> [--module <suffix>...] [--out file.json]
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const take = flag => { const out = []; for (let i = args.indexOf(flag); i >= 0; i = args.indexOf(flag)) { out.push(args[i + 1]); args.splice(i, 2); } return out; };
const modules = take('--module'), [outPath] = take('--out');
const [indexPath, blocksDir] = args;
if (!indexPath || !blocksDir) { console.error('usage: node rea-css-motion.cjs <blocks-index.json> <blocks-dir> [--module suffix] [--out file]'); process.exit(2); }
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const rows = (Array.isArray(index) ? index : index.rows).filter(r => /\.css(\?|$)/.test(r.url));

// Minimal CSS splitter: top-level rules, @media/@supports/@container bodies recursed, @keyframes kept whole.
function walk(css, out, at = '') {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    for (; j < css.length && depth; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; }
    const body = css.slice(open + 1, j - 1);
    if (/^@(-webkit-)?keyframes/.test(prelude)) out.push({ kind: 'keyframes', name: prelude.split(/\s+/)[1], at, css: `${prelude}{${body}}` });
    else if (/^@(media|supports|container|layer)/.test(prelude)) walk(body, out, prelude);
    else if (!prelude.startsWith('@')) out.push({ kind: 'rule', selector: prelude, at, decl: body });
    i = j;
  }
}
const suffixOf = s => (s.match(/_{1,2}[0-9a-f]{5,6}\b/) || [''])[0];
const result = { generatedFrom: path.resolve(indexPath), files: 0, keyframes: [], rules: [] };
for (const r of rows) {
  let css; try { css = fs.readFileSync(path.join(blocksDir, r.name), 'utf8'); } catch { continue; }
  result.files++;
  const items = []; walk(css, items);
  for (const it of items) {
    const source = { url: r.url, sha256: r.sha256 };
    if (it.kind === 'keyframes') {
      const mod = suffixOf(it.name);
      if (modules.length && !modules.includes(mod)) continue;
      result.keyframes.push({ name: it.name, module: mod, at: it.at || undefined, css: it.css, source });
    } else if (/(^|;)\s*(transition|animation)(-[a-z-]+)?\s*:/.test(it.decl)) {
      const mod = suffixOf(it.selector);
      if (modules.length && !modules.includes(mod)) continue;
      const motion = it.decl.split(';').map(d => d.trim()).filter(d => /^(transition|animation|transform|opacity|will-change)/.test(d));
      result.rules.push({ selector: it.selector, module: mod, at: it.at || undefined, motion, source });
    }
  }
}
const text = JSON.stringify(result, null, 1);
if (outPath) fs.writeFileSync(outPath, text);
console.log(`${result.files} CSS files: ${result.keyframes.length} @keyframes, ${result.rules.length} rules with transition/animation`);
