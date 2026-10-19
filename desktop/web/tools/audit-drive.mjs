// Visual audit driver: connects to triscord-web over the Chrome DevTools Protocol (tests/e2e/visual_audit_session.py)
// and runs one step: evaluate JavaScript in the page and/or save a page screenshot.
// Usage: node tools/audit-drive.mjs <cdp-url> [--js <code> | --js-file <file>] [--shot <file.png>] [--wait <ms>]
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const [cdp, ...rest] = process.argv.slice(2);
const opt = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts().flatMap(c => c.pages()).find(p => !p.url().includes('popout=')) ?? browser.contexts()[0].pages()[0];
const code = opt('js') ?? (opt('js-file') ? readFileSync(opt('js-file'), 'utf8') : undefined);
if (code) {
  const result = await page.evaluate(`(async () => { ${code} })()`);
  if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result));
}
if (opt('wait')) await page.waitForTimeout(Number(opt('wait')));
if (opt('shot')) { await page.screenshot({ path: opt('shot') }); console.log('shot', opt('shot')); }
await browser.close();   // disconnects; the app keeps running
