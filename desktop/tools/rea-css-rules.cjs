// Lists the CSS rules recovered from Discord's Chromium cache for given class-name prefixes, with the
// source asset URL and SHA-256 of each file (evidence for desktop/web). Read-only; never executes content.
//
// Usage: node rea-css-rules.cjs <blocks-index.json> <blocks-dir> <prefix> [prefix...] [--out file]
//   prefix: a CSS-module class stem such as "guilds_" or "panels_" (matches ".guilds_xxxxx"), or a module
//           hash suffix such as "__650eb" / "_afb27c" (matches every class of that CSS module).
// The rules are facts to re-implement in triscord's own CSS; the recovered files themselves are never
// shipped or copied into desktop/web.
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args.splice(outIndex, 2)[1] : null;
const [indexPath, blocksDir, ...prefixes] = args;
if (!indexPath || !blocksDir || prefixes.length === 0) {
  console.error('usage: node rea-css-rules.cjs <blocks-index.json> <blocks-dir> <prefix>... [--out file]');
  process.exit(2);
}
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')).filter(entry => /\.css(\?|$)/.test(entry.url));
const lines = [];
for (const entry of index) {
  const text = fs.readFileSync(path.join(blocksDir, entry.name), 'utf8');
  const matches = [];
  // Walk top-level rules and @media blocks; keep rules whose selector mentions a requested class stem.
  const ruleRe = /([^{}@]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(text))) {
    const selector = m[1].trim();
    if (prefixes.some(prefix => {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return prefix.startsWith('_')
        ? new RegExp(`\\.[A-Za-z0-9-]+${escaped}(?![A-Za-z0-9])`).test(selector) // whole CSS module by hash suffix
        : new RegExp(`\\.${escaped}[A-Za-z0-9_-]*`).test(selector);              // class stem in any module
    }))
      matches.push(`${selector} { ${m[2].trim()} }`);
  }
  if (matches.length) {
    lines.push(`/* ${entry.url}  sha256=${entry.sha256} */`);
    lines.push(...matches);
    lines.push('');
  }
}
const result = lines.join('\n');
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, result); }
else process.stdout.write(result);
console.error(`${prefixes.join(', ')}: ${lines.filter(l => l && !l.startsWith('/*')).length} rules`);
