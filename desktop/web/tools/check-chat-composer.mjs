// Runs the real Preact component in a private, headless Edge page; no account/network/audio.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(web, '../out/web-chat-composer');
mkdirSync(out, { recursive: true });
await build({
  stdin: { contents: `
    import {render} from 'preact';
    import {ChatPanel} from './src/components/ChatPanel';
    import './src/styles/base.css'; import './src/styles/frame.css'; import './src/styles/chat.css';
    document.documentElement.dataset.theme='midnight';
    window.sent=[];
    const bridge={send(c){window.sent.push(c);return 'test';},request(c){window.sent.push(c);return Promise.resolve();},onMessage(){}};
    render(<ChatPanel channelName="Geral" messages={[]} bridge={bridge} onClose={()=>{}}/>,document.getElementById('app'));
  `, resolveDir: web, sourcefile: 'composer-check.tsx', loader: 'tsx' },
  bundle: true, outfile: resolve(out, 'fixture.js'), jsx: 'automatic', jsxImportSource: 'preact',
});
writeFileSync(resolve(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="app"></div><script src="fixture.js"></script>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.goto(pathToFileURL(resolve(out, 'index.html')).href);
  const input = page.getByRole('textbox', { name: 'Conversar em Geral' });
  const height = () => input.evaluate(el => el.getBoundingClientRect().height);
  assert.equal(await height(), 56); checks.push('empty composer retains the observed 56px height');
  await input.fill('Primeira linha');
  await input.press('Shift+Enter');
  await input.press('a');
  assert.equal(await input.inputValue(), 'Primeira linha\na');
  assert.equal(await page.evaluate(() => window.sent.length), 0);
  assert.ok(await height() > 56); checks.push('Shift+Enter preserves a newline and grows the draft without sending');
  await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assert.equal(await page.evaluate(() => window.sent.length), 0); checks.push('IME composition Enter does not send');
  await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('textarea').value === '');
  assert.deepEqual(await page.evaluate(() => window.sent), [{ name: 'sendChatMessage', text: 'Primeira linha\na' }]);
  assert.equal(await height(), 56); checks.push('Enter sends one multiline message and restores the baseline');
  await input.fill(Array.from({ length: 60 }, (_, i) => `Linha ${i}`).join('\n'));
  assert.equal(await height(), 400);
  assert.ok(await input.evaluate(el => el.scrollHeight > el.clientHeight)); checks.push('long drafts scroll inside the 50vh cap');
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForFunction(() => document.querySelector('textarea').getBoundingClientRect().height === 300);
  checks.push('the draft follows the 50vh cap after a window resize');
  await input.fill('   '); await input.press('Enter');
  assert.equal(await page.evaluate(() => window.sent.length), 1); checks.push('blank drafts are not sent');
  await page.screenshot({ path: resolve(out, 'composer.png') });
  writeFileSync(resolve(out, 'report.json'), JSON.stringify({ passed: checks.length, checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }));
} finally { await browser.close(); }
