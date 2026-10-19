// Renders the interface in Edge (Chromium, same engine as WebView2) in the state of a Discord reference
// capture and compares them region by region.
//   node tools/compare.mjs [--fixture reference] [--theme dark]
// Outputs desktop/out/web-compare/: triscord.png, side-by-side.png, diff-<region>.png, report.json.
// gg sans is injected only here, from the local-only desktop/assets/fonts-local (never shipped).
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REGIONS } from './regions.mjs';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(web, '..');
const out = resolve(desktop, 'out/web-compare');
mkdirSync(out, { recursive: true });
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const reference = PNG.sync.read(readFileSync(resolve(desktop, 'out/reference/discord-nav-client.png')));

const fontsDir = resolve(desktop, 'assets/fonts-local');
const weights = { normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800 };
const fontCss = existsSync(fontsDir) ? readdirSync(fontsDir).filter(f => f.endsWith('.ttf')).map(f => {
  const weight = weights[f.replace(/^ggsans-|\.ttf$/g, '')];
  return `@font-face{font-family:"gg sans";font-weight:${weight};src:url(data:font/ttf;base64,${readFileSync(resolve(fontsDir, f)).toString('base64')}) format("truetype")}`;
}).join('\n') : '';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: reference.width, height: reference.height }, deviceScaleFactor: 1 });
await page.goto(`${pathToFileURL(resolve(web, 'dist/index.html'))}?theme=${arg('theme', 'dark')}&fixture=${arg('fixture', 'reference')}`);
if (fontCss) await page.addStyleTag({ content: fontCss });
await page.evaluate(() => document.fonts.ready);
const shot = PNG.sync.read(await page.screenshot());
writeFileSync(resolve(out, 'triscord.png'), PNG.sync.write(shot));

const report = { fonts: fontCss ? 'gg sans (local)' : 'fallback', regions: [] };
for (const region of REGIONS) {
  const ours = region.ours ? await page.locator(region.ours).first().boundingBox() : null;
  const at = ours ? { x: Math.round(ours.x) + (region.dx ?? 0), y: Math.round(ours.y) + (region.dy ?? 0) } : { x: region.x, y: region.y };
  const crop = (img, x, y) => { const c = new PNG({ width: region.w, height: region.h }); PNG.bitblt(img, c, x, y, region.w, region.h, 0, 0); return c; };
  const a = crop(reference, region.x, region.y), b = crop(shot, at.x, at.y);
  const diff = new PNG({ width: region.w, height: region.h });
  const mismatched = pixelmatch(a.data, b.data, diff.data, region.w, region.h, { threshold: 0.1 });
  writeFileSync(resolve(out, `diff-${region.name}.png`), PNG.sync.write(diff));
  report.regions.push({ name: region.name, note: region.note, reference: [region.x, region.y], ours: [at.x, at.y],
    size: [region.w, region.h], mismatchPercent: +(100 * mismatched / (region.w * region.h)).toFixed(2) });
}
// Side by side: reference left, triscord right.
const side = new PNG({ width: reference.width * 2 + 16, height: reference.height });
PNG.bitblt(reference, side, 0, 0, reference.width, reference.height, 0, 0);
PNG.bitblt(shot, side, 0, 0, shot.width, shot.height, reference.width + 16, 0);
writeFileSync(resolve(out, 'side-by-side.png'), PNG.sync.write(side));
writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 1));
await browser.close();
for (const r of report.regions) console.log(`${r.name.padEnd(22)} ${String(r.mismatchPercent).padStart(6)}% differ  ref@${r.reference} ours@${r.ours}`);
