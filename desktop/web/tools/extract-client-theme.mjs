// Generates the "Algodão-doce" (COTTON_CANDY) colour theme from Discord's own code and CSS recovered with REA.
// No Discord JavaScript is executed: its algorithm is ported below and Chromium (installed Edge, WebView2's engine)
// resolves every token with Discord's color-mix() declarations.
//
// Evidence (local, never shipped):
//   --tokens   Discord's token sheet (out/claude-observations/rea-css/discord-bundle.css, sha256 c791ccd3…): the
//              :root / .theme-* blocks, including the @supports color-mix versions that mix each token with
//              --custom-theme-base-color / --custom-theme-text-color
//   --gradient CSS module 419070 (out/discord-styles-recovered-20261014/419070.5a76dee70a3767eb.css, sha256 7e4c21df…):
//              .custom-theme-background rules (gradient layer colours and opacities, base/text per light/dark)
// From the web bundle (web.3a122a9dc6c39305.js, a17f801ade545f60.js):
//   - preset COTTON_CANDY: theme LIGHT, tokens BG_GRADIENT_COTTON_CANDY_1 @ 8.5%, _2 @ 94.28%, angle 180.14,
//     name "Algodão-doce" (godtzA);
//   - getLinearGradient: `linear-gradient(${angle}deg, ${token colour, saturation 1} ${stop}%, …)`;
//   - preset CSS (module 153469 `m`): .custom-theme-background { --custom-theme-background, primary = first stop,
//     secondary = last stop, and the variables of module 345815 `c` with enabled, baseMixAmount 50, textMixAmount 38 };
//   - `a` (base/text colours): darker/lighter by WCAG luminance; light base = lighter, s 1, l .9; text = darker,
//     s 1, l .25 for hues 200..300 else .15 (dark: base = darker s 1 l .05, text = lighter s 1, l .8 / .95).
// Output: desktop/web/src/theme-cotton-candy.generated.css (tokens our CSS uses + the gradient layer variables).
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const tokensPath = arg('tokens'), gradientPath = arg('gradient');
if (!tokensPath || !gradientPath) { console.error('usage: node tools/extract-client-theme.mjs --tokens <discord-bundle.css> --gradient <419070.css>'); process.exit(2); }
const tokensCss = readFileSync(tokensPath, 'utf8'), gradientCss = readFileSync(gradientPath, 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');

// Tokens our own CSS references (same rule as extract-tokens.mjs), plus the gradient layers the theme adds.
const used = new Set();
const walk = dir => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.css') && !/generated\.css$/.test(p)) for (const m of readFileSync(p, 'utf8').matchAll(/var\((--[A-Za-z0-9_-]+)/g)) used.add(m[1]); } };
walk(join(web, 'src'));
const own = name => /^--tri-/.test(name);
const LAYERS = ['--custom-theme-background', '--background-gradient-lowest', '--background-gradient-lower', '--background-gradient-low',
  '--background-gradient-high', '--background-gradient-higher', '--background-gradient-highest', '--background-gradient-chat',
  '--background-gradient-app-frame', '--app-border-frame'];
const names = [...new Set([...used].filter(n => !own(n)).concat(LAYERS))].sort();

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
await page.setContent(`<!doctype html><html><head><style>${tokensCss}\n${gradientCss}</style></head><body><div id="probe"></div></body></html>`);
const result = await page.evaluate(({ names }) => {
  // --- chroma-js operations Discord uses, on sRGB ---
  const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const toHsl = ([r, g, b]) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [NaN, 0, l];
    const d = max - min, s = l < 0.5 ? d / (max + min) : d / (2 - max - min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  };
  const fromHsl = ([h, s, l]) => {
    if (Number.isNaN(h)) h = 0;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, k = h / 360;
    const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(k + 1 / 3), f(k), f(k - 1 / 3)].map(x => x * 255);
  };
  const set = (rgb, key, v) => { const hsl = toHsl(rgb); hsl[{ h: 0, s: 1, l: 2 }[key]] = v; return fromHsl(hsl); };
  const css = rgb => `rgb(${rgb.map(x => Math.round(x)).join(',')})`;
  const hslVar = rgb => { const [h, s, l] = toHsl(rgb.map(x => Math.round(x))); return `${Number.isNaN(h) ? 0 : h} ${100 * s}% ${100 * l}%`; };
  // --- Discord: a({primaryColor, secondaryColor, isDarkTheme}) ---
  const baseText = (primary, secondary, dark) => {
    const p = hex2rgb(primary), s = hex2rgb(secondary);
    let [hi, lo] = luminance(p) > luminance(s) ? [p, s] : [s, p];
    const hue = toHsl(lo)[0];
    if (hue === 0 || Number.isNaN(hue)) lo = hi;
    let text = dark ? set(hi, 's', 1) : set(lo, 's', 1);
    const th = toHsl(text)[0];
    text = set(text, 'l', th >= 200 && th <= 300 ? (dark ? 0.8 : 0.25) : (dark ? 0.95 : 0.15));
    return { base: dark ? set(set(lo, 's', 1), 'l', 0.05) : set(set(hi, 's', 1), 'l', 0.9), text };
  };
  // Token colours at saturation 1, as Discord's nt(token, {saturation: 1}).
  const probe = document.getElementById('probe');
  const colour = name => {
    probe.style.setProperty('--saturation-factor', '1');
    probe.style.color = `hsl(var(--${name}-hsl))`;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = getComputedStyle(probe).color; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  };
  const stops = [['bg-gradient-cotton-candy-1', 8.5], ['bg-gradient-cotton-candy-2', 94.28]].map(([t, stop]) => ({ hex: colour(t), stop }));
  const primary = stops[0].hex, secondary = stops.at(-1).hex;
  const light = baseText(primary, secondary, false), dark = baseText(primary, secondary, true);
  const vars = {
    '--custom-theme-background': `linear-gradient(180.14deg, ${stops.map(s => `${s.hex} ${s.stop}%`).join(', ')})`,
    '--custom-theme-primary-color': primary, '--custom-theme-secondary-color': secondary,
    '--custom-theme-base-color-amount': '50%', '--custom-theme-text-color-amount': '38%',
    '--custom-theme-base-color-light-hsl': hslVar(light.base), '--custom-theme-base-color-light': css(light.base), '--custom-theme-text-color-light': css(light.text),
    '--custom-theme-base-color-dark-hsl': hslVar(dark.base), '--custom-theme-base-color-dark': css(dark.base), '--custom-theme-text-color-dark': css(dark.text),
  };
  const read = cls => {
    document.documentElement.className = cls;
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.removeProperty(k);
    if (cls.includes('custom-theme-background')) for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
    const out = {}, root = getComputedStyle(document.documentElement);
    for (const name of names) {
      const raw = root.getPropertyValue(name).trim();
      if (!raw) continue;
      if (/gradient|url\(/.test(raw) || name.startsWith('--background-gradient') || name === '--custom-theme-background') { out[name] = raw; continue; }
      probe.style.color = 'rgb(1, 2, 3)'; probe.style.color = `var(${name})`;
      const c = getComputedStyle(probe).color;
      // Colours only (as extract-tokens.mjs: shadows and lengths are not colours); the rest is not mixed.
      if (c && c !== 'rgb(1, 2, 3)' && /(hsla?|rgba?|color-mix|oklab|#|transparent|white|black)/i.test(raw) && !/\d+px\s/.test(raw)) out[name] = c;
    }
    return out;
  };
  return { stops, vars, plainLight: read('theme-light'), pink: read('theme-light custom-theme-background') };
}, { names });
await browser.close();

// Check: without the custom theme the same pipeline must give tokens.generated.css's light values.
const generated = readFileSync(join(web, 'src', 'tokens.generated.css'), 'utf8');
const lightBlock = generated.slice(generated.indexOf(':root[data-theme="light"]'), generated.indexOf('}', generated.indexOf(':root[data-theme="light"]')));
let checked = 0, differ = [];
const lightValues = {};
for (const m of lightBlock.matchAll(/(--[\w-]+): ([^;]+);/g)) {
  lightValues[m[1]] = m[2].trim();
  if (!(m[1] in result.plainLight)) continue;   // not a colour: copied from the light theme below
  checked++;
  if (result.plainLight[m[1]] !== m[2].trim()) differ.push(`${m[1]}: generated ${m[2]} / now ${result.plainLight[m[1]]}`);
}
for (const [name, value] of Object.entries(lightValues)) if (!(name in result.pink)) result.pink[name] = value;
console.log(`light colour tokens re-resolved: ${checked - differ.length}/${checked} identical`);
if (differ.length) { console.log(differ.slice(0, 15).join('\n')); process.exit(1); }

const lines = ['/* Generated by tools/extract-client-theme.mjs: Discord\'s "Algodão-doce" colour theme (COTTON_CANDY, light base),',
  ` * tokens sheet sha256 ${sha(tokensCss).slice(0, 16)}…, module 419070 sha256 ${sha(gradientCss).slice(0, 16)}…;`,
  ` * stops ${result.stops.map(s => `${s.hex} ${s.stop}%`).join(', ')}. Do not edit by hand. */`,
  ':root[data-theme="cotton-candy"] {'];
for (const name of Object.keys(result.pink).sort()) lines.push(`  ${name}: ${result.pink[name]};`);
lines.push('}');
writeFileSync(join(web, 'src', 'theme-cotton-candy.generated.css'), lines.join('\n') + '\n');
console.log(`theme-cotton-candy.generated.css: ${Object.keys(result.pink).length} variables; base ${result.vars['--custom-theme-base-color-light']}, text ${result.vars['--custom-theme-text-color-light']}`);
