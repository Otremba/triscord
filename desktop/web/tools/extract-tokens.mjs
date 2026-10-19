// Generates triscord's design tokens from Discord's own token declarations recovered (REA) from the
// Chromium disk cache. Only custom-property declarations in :root / .theme-* scopes are read; no Discord
// JavaScript is executed. The installed Edge (Chromium, the same engine as WebView2) computes each token's
// final value per theme (var(), calc(), hsl(), color-mix()), so nothing is resolved by hand.
//
// Inputs (local evidence, never shipped):
//   --index  blocks-index.json from desktop/tools/rea blockfile reader   --blocks  its blocks/ directory
//   --tokens the decoded token sheet (e.g. decoded/f_0000d2)
// Outputs:
//   desktop/out/web-tokens/tokens.<theme>.json   every resolved token + provenance (evidence, gitignored)
//   desktop/web/src/tokens.generated.css         only the tokens referenced by desktop/web/src/**/*.css
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const desktop = resolve(web, '..');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : process.env[`TRISCORD_REA_${name.toUpperCase()}`]; };
const indexPath = arg('index'), blocksDir = arg('blocks'), tokenSheet = arg('tokens');
if (!indexPath || !blocksDir || !tokenSheet) {
  console.error('usage: node tools/extract-tokens.mjs --index <blocks-index.json> --blocks <dir> --tokens <decoded token sheet>');
  process.exit(2);
}
const THEMES = { light: 'theme-light', dark: 'theme-dark', darker: 'theme-darker', midnight: 'theme-midnight' };
const SCOPE = /^(:root|html|body|\.theme-(dark|midnight|light|darker)|\.platform-win|\.app-[a-z-]+)$/;

// 1. Collect custom-property declarations from global/theme scopes, in source order, with provenance.
const sources = [{ url: 'decoded token sheet', path: tokenSheet }];
for (const entry of JSON.parse(readFileSync(indexPath, 'utf8')))
  if (/\.css(\?|$)/.test(entry.url)) sources.push({ url: entry.url, path: join(blocksDir, entry.name) });
const blocks = [];
const origin = {};
for (const source of sources) {
  const text = readFileSync(source.path, 'utf8');
  const sha256 = createHash('sha256').update(text).digest('hex');
  for (const m of text.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map(s => s.trim());
    if (!selectors.every(s => SCOPE.test(s))) continue;
    const decls = [...m[2].matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+)/g)];
    if (!decls.length) continue;
    blocks.push(`${selectors.join(',')}{${decls.map(d => `${d[1]}:${d[2]}`).join(';')}}`);
    for (const d of decls) origin[d[1]] ??= { url: source.url, sha256 };
  }
}
const names = Object.keys(origin);
console.log(`declarations: ${blocks.length} blocks, ${names.length} tokens from ${sources.length} files`);

// 2. Let Chromium resolve every token per theme.
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
const resolved = {};
for (const [theme, cls] of Object.entries(THEMES)) {
  await page.setContent(`<!doctype html><html class="${cls}"><head><style>${blocks.join('\n')}</style></head><body><div id="probe"></div></body></html>`);
  resolved[theme] = await page.evaluate(names => {
    const probe = document.getElementById('probe');
    const root = getComputedStyle(document.documentElement);
    const out = {};
    for (const name of names) {
      const raw = root.getPropertyValue(name).trim();
      if (!raw) continue;
      let value = raw, kind = 'raw';
      if (/(hsla?|rgba?|color-mix|oklab|oklch|#[0-9a-f]{3,8}\b|\btransparent\b|\bwhite\b|\bblack\b)/i.test(raw) && !/gradient|url\(|\d+px\s/.test(raw)) {
        probe.style.color = 'rgb(1, 2, 3)';
        probe.style.color = `var(${name})`;
        const color = getComputedStyle(probe).color;
        if (color && color !== 'rgb(1, 2, 3)') {
          value = color; kind = 'color';
          // sRGB hex for humans and pixel comparisons (canvas rasterises the exact computed colour).
          const ctx = (window.__canvas ??= document.createElement('canvas')).getContext('2d', { willReadFrequently: true });
          ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          out[name] = { value, kind, raw, hex: '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('') + (a < 255 ? a.toString(16).padStart(2, '0') : '') };
          continue;
        }
      } else if (/^(-?[\d.]+(px|rem|em)|calc\(|max\(|min\(|clamp\()/.test(raw)) {
        probe.style.width = '0px';
        probe.style.width = `var(${name})`;
        const width = getComputedStyle(probe).width;
        if (width && width !== '0px' && !/%/.test(raw)) { value = width; kind = 'length'; }
      }
      out[name] = { value, kind, raw };
    }
    return out;
  }, names);
}
await browser.close();

// 3. Evidence: everything, with provenance.
const evidenceDir = join(desktop, 'out', 'web-tokens');
mkdirSync(evidenceDir, { recursive: true });
for (const theme of Object.keys(THEMES)) {
  const table = Object.fromEntries(Object.entries(resolved[theme]).map(([n, v]) => [n, { ...v, source: origin[n] }]));
  writeFileSync(join(evidenceDir, `tokens.${theme}.json`), JSON.stringify(table, null, 1));
}

// 4. Ship only what our own CSS references.
const used = new Set();
const walk = dir => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.css') && !p.endsWith('tokens.generated.css')) for (const m of readFileSync(p, 'utf8').matchAll(/var\((--[A-Za-z0-9_-]+)/g)) used.add(m[1]); } };
walk(join(web, 'src'));
const own = name => /^--tri-/.test(name); // triscord's own (non-Discord) variables are defined in our CSS
const missing = [...used].filter(n => !own(n) && !resolved.midnight[n]);
const lines = ['/* Generated by tools/extract-tokens.mjs from Discord token declarations recovered with REA.',
  ' * Values computed by Chromium per theme; provenance in desktop/out/web-tokens/. Do not edit by hand. */'];
for (const [theme, cls] of Object.entries(THEMES)) {
  lines.push(`:root[data-theme="${theme}"] {`);
  for (const name of [...used].filter(n => resolved[theme][n]).sort()) lines.push(`  ${name}: ${resolved[theme][name].value};`);
  lines.push('}');
}
writeFileSync(join(web, 'src', 'tokens.generated.css'), lines.join('\n') + '\n');
console.log(`tokens.generated.css: ${[...used].filter(n => resolved.midnight[n]).length} tokens used by the UI`);
if (missing.length) console.log(`NOT FOUND in recovered tokens (fix the CSS or record as a gap): ${missing.join(', ')}`);
