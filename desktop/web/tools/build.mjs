// Builds the shared interface and the assets embedded by the Tauri host.
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauri = process.argv.includes('--tauri');

// Compile the shared Tailwind styles.
const tailwindCssInput = readFileSync(resolve(web, 'src/styles/tailwind.css'), 'utf-8');
const tailwindResult = await postcss([
  tailwindcss(resolve(web, 'tailwind.config.cjs')),
  autoprefixer,
]).process(tailwindCssInput, {
  from: resolve(web, 'src/styles/tailwind.css'),
  to: resolve(web, 'src/styles/tailwind.generated.css'),
});
writeFileSync(resolve(web, 'src/styles/tailwind.generated.css'), tailwindResult.css);

const dist = resolve(web, tauri ? 'dist-rust' : 'dist');
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [resolve(web, 'src/main.tsx')], bundle: true, minify: true, sourcemap: true,
  outfile: resolve(dist, 'app.js'), format: 'iife', target: 'chrome120',
  jsx: 'automatic', jsxImportSource: 'preact', loader: { '.css': 'css', '.png': 'dataurl' }, legalComments: 'none',
});
// Discord's font, gg sans, when the local-only desktop/assets/fonts-local has it (git-ignored; see its README:
// proprietary, the user chose to use it on 15/10/2026, and a distributable build must leave it out). Without it
// --font-primary falls back to Noto Sans / Helvetica / Arial.
const fontsDir = resolve(web, '../assets/fonts-local');
const weights = { normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800 };
const weightOf = file => {
  const m = file.match(/^ggsans-(\d+)/) || file.match(/^ggsans-([a-z]+)/);
  if (!m) return undefined;
  if (/^\d+$/.test(m[1])) return Number(m[1]);
  return weights[m[1]];
};
const fonts = existsSync(fontsDir) ? readdirSync(fontsDir).filter(f => /^ggsans-.*\.(woff2|ttf)$/.test(f)) : [];
rmSync(resolve(dist, 'fonts'), { recursive: true, force: true });
rmSync(resolve(dist, 'fonts.css'), { force: true });
if (fonts.length) {
  mkdirSync(resolve(dist, 'fonts'), { recursive: true });
  for (const f of fonts) copyFileSync(resolve(fontsDir, f), resolve(dist, 'fonts', f));
  const rules = [];
  if (fonts.includes('ggsans-vf.woff2')) {
    rules.push('@font-face{font-family:"gg sans";font-style:normal;font-weight:300 800;font-display:swap;src:url(fonts/ggsans-vf.woff2) format("woff2-variations"),url(fonts/ggsans-vf.woff2) format("woff2");}');
  }
  for (const f of fonts) {
    if (f === 'ggsans-vf.woff2') continue;
    const w = weightOf(f);
    if (!w) continue;
    const fmt = f.endsWith('.woff2') ? 'woff2' : 'truetype';
    rules.push(`@font-face{font-family:"gg sans";font-style:normal;font-weight:${w};font-display:swap;src:url(fonts/${f}) format("${fmt}");}`);
  }
  writeFileSync(resolve(dist, 'fonts.css'), rules.join('\n') + '\n');
}
console.log(`fonts: ${fonts.length ? fonts.join(', ') : 'gg sans not found, using the fallback stack'}`);
// CSP: no network from the renderer (the core does all I/O); images only from the app origin/data.
writeFileSync(resolve(dist, 'index.html'), `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
${tauri ? '' : '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\' data:; connect-src \'none\'; media-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">'}
<title>Triscord</title>
${fonts.length ? '<link rel="stylesheet" href="fonts.css">\n' : ''}<link rel="stylesheet" href="app.css">
</head>
<body><div id="app"></div><script src="app.js"></script></body>
</html>
`);
console.log('built', dist);
