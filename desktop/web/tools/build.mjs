// Builds the interface into desktop/web/dist (index.html, app.js, app.css), the folder the native host
// maps to https://app.triscord/ in WebView2. Icons are regenerated from the C++ list first.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [resolve(web, 'tools/icons-from-cpp.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [resolve(web, 'tools/spring-easing.mjs')], { stdio: 'inherit' });
const dist = resolve(web, 'dist');
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
const weightOf = file => weights[file.slice('ggsans-'.length, -'.ttf'.length)];
const fonts = existsSync(fontsDir) ? readdirSync(fontsDir).filter(f => /^ggsans-\w+\.ttf$/.test(f) && weightOf(f)) : [];
rmSync(resolve(dist, 'fonts'), { recursive: true, force: true });
rmSync(resolve(dist, 'fonts.css'), { force: true });
if (fonts.length) {
  mkdirSync(resolve(dist, 'fonts'), { recursive: true });
  for (const f of fonts) copyFileSync(resolve(fontsDir, f), resolve(dist, 'fonts', f));
  writeFileSync(resolve(dist, 'fonts.css'), fonts.map(f =>
    `@font-face{font-family:"gg sans";font-style:normal;font-weight:${weightOf(f)};font-display:block;src:url(fonts/${f}) format("truetype")}`).join('\n') + '\n');
}
console.log(`fonts: ${fonts.length ? fonts.join(', ') : 'gg sans not found, using the fallback stack'}`);
// CSP: no network from the renderer (the core does all I/O); images only from the app origin/data.
writeFileSync(resolve(dist, 'index.html'), `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>Triscord</title>
${fonts.length ? '<link rel="stylesheet" href="fonts.css">\n' : ''}<link rel="stylesheet" href="app.css">
</head>
<body><div id="app"></div><script src="app.js"></script></body>
</html>
`);
console.log('built', dist);
