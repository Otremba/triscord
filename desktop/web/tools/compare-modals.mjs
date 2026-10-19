// Renders the "Criar canal" and invite modals in Edge (Chromium, same engine as WebView2) and compares them
// with Discord's captures (desktop/out/claude-observations/discord-create-channel-voice.png and
// discord-invite-copied.png, dark theme, 100% scale).
//   node tools/compare-modals.mjs
// triscord leaves out rows without a triscord function (Texto/Fórum, "Canal privado", the friends list), so
// regions are compared piecewise: each pair names a crop of the Discord modal and the matching element of
// ours. Outputs desktop/out/web-compare-modals/: side-by-side PNGs, diffs and report.json.
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(web, '..');
const out = resolve(desktop, 'out/web-compare-modals');
mkdirSync(out, { recursive: true });
const obs = name => PNG.sync.read(readFileSync(resolve(desktop, 'out/claude-observations', name)));

const fontsDir = resolve(desktop, 'assets/fonts-local');
const weights = { normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800 };
const fontCss = existsSync(fontsDir) ? readdirSync(fontsDir).filter(f => f.endsWith('.ttf')).map(f => {
  const weight = weights[f.replace(/^ggsans-|\.ttf$/g, '')];
  return `@font-face{font-family:"gg sans";font-weight:${weight};src:url(data:font/ttf;base64,${readFileSync(resolve(fontsDir, f)).toString('base64')}) format("truetype")}`;
}).join('\n') : '';

function crop(png, x, y, w, h) {
  const c = new PNG({ width: w, height: h });
  for (let r = 0; r < h; r++) png.data.copy(c.data, r * w * 4, ((y + r) * png.width + x) * 4, ((y + r) * png.width + x + w) * 4);
  return c;
}
function sideBySide(a, b) {
  const w = a.width + b.width + 8, h = Math.max(a.height, b.height), s = new PNG({ width: w, height: h });
  s.data.fill(255);
  for (const [img, ox] of [[a, 0], [b, a.width + 8]])
    for (let r = 0; r < img.height; r++) img.data.copy(s.data, (r * w + ox) * 4, r * img.width * 4, (r + 1) * img.width * 4);
  return s;
}
// Rows that differ from the modal surface: a cheap layout fingerprint to align ours with Discord's.
function inkRows(png, bg = [0x39, 0x3a, 0x41]) {
  const runs = []; let start = -1;
  for (let y = 0; y < png.height; y++) {
    let ink = false;
    for (let x = 2; x < png.width - 2 && !ink; x++) {
      const i = (y * png.width + x) * 4;
      if (Math.abs(png.data[i] - bg[0]) + Math.abs(png.data[i + 1] - bg[1]) + Math.abs(png.data[i + 2] - bg[2]) > 12) ink = true;
    }
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) { runs.push(`${start}-${y - 1}`); start = -1; }
  }
  if (start >= 0) runs.push(`${start}-${png.height - 1}`);
  return runs.join(' ');
}

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1264, height: 892 }, deviceScaleFactor: 1 });
await page.goto(`${pathToFileURL(resolve(web, 'dist/index.html'))}?theme=dark&fixture=reference`);
if (fontCss) await page.addStyleTag({ content: fontCss });
// Pin the modal to a whole-pixel top: a centred modal of odd height lands on a half pixel and shifts the text.
await page.addStyleTag({ content: '.tri-modal-backdrop{align-items:flex-start;padding-top:40px}' });
await page.waitForSelector('.tri-category__add');

// Discord modal boxes in the captures (window coordinates; border included).
const cases = [
  { name: 'create-channel', capture: 'discord-create-channel-voice.png', box: [400, 159, 480, 574],
    open: () => page.click('.tri-category__add'),
    // [label, discord y, height, our selector, dy inside it]
    pairs: [['header', 0, 92, '.tri-dmodal', 0], ['type-label', 96, 28, '.tri-field__label', -4],
            ['voice-option', 186, 76, '.tri-radio', 0], ['name-field', 332, 72, '.tri-create-channel > .tri-field:last-child', -4],
            ['actions', 493, 64, '.tri-dmodal__actions', 0]] },
  { name: 'invite', capture: 'discord-invite-copied.png', box: [400, 56, 480, 780],
    open: () => page.click('[aria-label="Convidar pessoas"]'),
    pairs: [['header', 0, 50, '.tri-dmodal', 0], ['copy-input', 691, 40, '.tri-copy-input', 0]] },
];
const report = {};
for (const c of cases) {
  await c.open();
  await page.waitForSelector('.tri-dmodal');
  await page.waitForTimeout(150);
  const ours = PNG.sync.read(await page.locator('.tri-dmodal').screenshot());
  const ref = obs(c.capture);
  const theirs = crop(ref, ...c.box);
  writeFileSync(resolve(out, `${c.name}-side-by-side.png`), PNG.sync.write(sideBySide(theirs, ours)));
  const modalBox = await page.locator('.tri-dmodal').boundingBox();
  const entry = { size: { discord: [c.box[2], c.box[3]], triscord: [ours.width, ours.height] }, inkRows: { discord: inkRows(theirs), triscord: inkRows(ours) }, regions: {} };
  for (const [label, y, h, selector, dy] of c.pairs) {
    const el = await page.locator(selector).first().boundingBox();
    const oy = Math.round(el.y - modalBox.y) + dy;
    if (oy < 0 || oy + h > ours.height) { entry.regions[label] = 'out of bounds'; continue; }
    const a = crop(theirs, 0, y, theirs.width, h), b = crop(ours, 0, oy, ours.width, h);
    const diff = new PNG({ width: a.width, height: h });
    const n = pixelmatch(a.data, b.data, diff.data, a.width, h, { threshold: 0.1 });
    writeFileSync(resolve(out, `${c.name}-${label}-diff.png`), PNG.sync.write(sideBySide(sideBySide(a, b), diff)));
    entry.regions[label] = { oursY: oy, differentPixels: n, percent: +(100 * n / (a.width * h)).toFixed(2) };
  }
  report[c.name] = entry;
  await page.keyboard.press('Escape');
}
writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
