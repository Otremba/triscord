// Real component/CSS in a private headless Edge page. Does not draw or test Qt's native video/badges.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(web, '../out/web-video-tile');
mkdirSync(out, { recursive: true });
await build({
  stdin: { contents: `
    import {render} from 'preact';
    import {VideoTile} from './src/components/VideoTile';
    import './src/styles/base.css'; import './src/styles/frame.css';
    import './src/styles/call.css'; import './src/styles/voice.css';
    import './src/styles/call-view-controls.css';
    document.documentElement.dataset.theme='midnight';
    window.sent=[]; window.focusClicks=0; window.contextMenus=0;
    const bridge={send(c){window.sent.push(c);return 'test';},request(c){window.sent.push(c);return Promise.resolve();},onMessage(){}};
    const stream={id:'screen-test',kind:'screen',ownerId:'self',title:'camargo',width:1280,height:720,path:'native-overlay'};
    window.showTile=(hidden=false)=>render(
      <div class="tri-call-grid" style={{width:'432px',height:'243px',padding:'0',gridTemplateColumns:'432px'}}>
        <VideoTile stream={{...stream,hidden}} bridge={bridge}
          onContextMenu={e=>{e.preventDefault();window.contextMenus++;}}
          onClick={()=>window.focusClicks++}/>
      </div>,document.getElementById('app'));
    window.showTile();
  `, resolveDir: web, sourcefile: 'video-tile-check.tsx', loader: 'tsx' },
  bundle: true, outfile: resolve(out, 'fixture.js'), jsx: 'automatic', jsxImportSource: 'preact',
});
// Reuse the existing local font sheet; this test never builds or modifies dist.
const fonts = pathToFileURL(resolve(web, 'dist/fonts.css')).href;
writeFileSync(resolve(out, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${fonts}"><link rel="stylesheet" href="fixture.css"><div id="app"></div><script src="fixture.js"></script>`);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  // Fail closed if a fixture unexpectedly attempts external requests.
  await page.route(/^https?:/, route => route.abort());
  await page.goto(pathToFileURL(resolve(out, 'index.html')).href);
  await page.evaluate(() => document.fonts.ready);
  const tile = page.locator('.tri-video-tile');
  await page.waitForFunction(() => window.sent.some(c => c.name === 'videoSurface' && c.rect.height > 0));
  const geometry = await tile.evaluate(el => {
    const rect = node => { const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}; };
    return { tile:rect(el), surface:rect(el.querySelector('.tri-video-tile__surface')) };
  });
  assert.equal(geometry.tile.width, 432); assert.equal(geometry.tile.height, 243);
  assert.deepEqual(geometry.surface, geometry.tile);
  checks.push('432×243 screen tile gives the entire cell to the video surface');
  assert.equal(await tile.locator('.tri-video-tile__controls,[role="toolbar"],button,svg').count(), 0);
  assert.equal((await tile.textContent()).trim(), '');
  assert.equal(await tile.getAttribute('aria-label'), 'camargo');
  checks.push('visible screen has no footer, Tela de label, profile/camera buttons or extra icons');
  const surface = await page.evaluate(() => window.sent.filter(c => c.name === 'videoSurface' && c.rect.height > 0).at(-1));
  assert.deepEqual(surface.rect, geometry.surface);
  assert.equal(surface.streamId, 'screen-test');
  checks.push('native videoSurface report uses the full 432×243 rectangle');
  await tile.click({ position: { x: 100, y: 100 } });
  assert.equal(await page.evaluate(() => window.focusClicks), 1);
  await tile.click({ button: 'right', position: { x: 120, y: 100 } });
  assert.equal(await page.evaluate(() => window.contextMenus), 1);
  assert.equal(await page.evaluate(() => window.focusClicks), 1);
  checks.push('normal click focuses once and right click invokes the participant context handler');
  await page.screenshot({ path: resolve(out, 'visible.png') });
  await page.evaluate(() => { window.sent=[]; window.showTile(true); });
  const restore = page.getByRole('button', { name: 'Mostrar transmissão', exact: true });
  await restore.waitFor();
  await page.waitForFunction(() => window.sent.some(c => c.name === 'videoSurface'));
  const hiddenReports = await page.evaluate(() => window.sent.filter(c => c.name === 'videoSurface'));
  assert.ok(hiddenReports.length > 0);
  assert.ok(hiddenReports.every(c => Object.values(c.rect).every(v => v === 0)));
  checks.push('hidden transmission has a restore placeholder and reports no native surface');
  await restore.click();
  assert.deepEqual(await page.evaluate(() => window.sent.filter(c => c.name === 'setStreamHidden')),
    [{ name: 'setStreamHidden', streamId: 'screen-test', hidden: false }]);
  assert.equal(await page.evaluate(() => window.focusClicks), 1);
  checks.push('restore button sends setStreamHidden false without triggering tile focus');
  await page.screenshot({ path: resolve(out, 'hidden.png') });
  await page.evaluate(() => { window.sent=[]; window.showTile(false); });
  await page.waitForFunction(() => window.sent.some(c => c.name === 'videoSurface' && c.rect.height === 243));
  assert.equal(await tile.locator('button').count(), 0);
  checks.push('unhidden state restores the full native surface without leaving placeholder controls');
  writeFileSync(resolve(out, 'report.json'), JSON.stringify({ passed: checks.length, checks,
    limitations: ['Headless DOM/bridge geometry only; Qt rendering, video pixels, native fonts and badge fidelity require native tests.'] }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }));
} finally { await browser.close(); }
