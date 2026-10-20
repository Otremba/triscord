// Error reports (src/error_reports.js): upload with a session, limits, scrubbing, retention and the admin API.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const adminKey = 'local-admin-key-0123456789';
const bundlePath = resolve(process.env.TRISCORD_CONTROL_TEST_BUNDLE || 'out/worker.js');
const mf = new Miniflare(convertV4MiniflareOptions({ scriptPath: bundlePath, modules: true,
  compatibilityDate: '2026-10-12', host: '127.0.0.1', port: 0,
  durableObjects: { HUB: { className: 'TriscordHub', useSQLite: true } }, bindings: { INVITE_CODE: 'local-test-private-group-code', ADMIN_KEY: adminKey },
  d1Databases: { DB: 'triscord-accounts-reports-test' } }));
const db = await mf.getD1Database('DB');
for (const file of ['../cloudflare-auth/schema.sql', 'migrations/0001_servers.sql', 'migrations/0002_error_reports.sql']) {
  const statements = readFileSync(resolve(file), 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const statement of statements) await db.exec(statement);
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function account(id, nick) {
  const token = (await sha256Hex('token-' + id)), now = Date.now();
  await db.prepare('INSERT INTO accounts(id, email, nick, nick_lower, avatar_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, `${id}@example.com`, nick, nick.toLowerCase(), null, now, now).run();
  await db.prepare('INSERT INTO sessions(token_hash, account_id, created_at, expires_at) VALUES (?,?,?,?)').bind(await sha256Hex(token), id, now, now + 86400000).run();
  return token;
}
const upload = (token, text, headers = {}) => mf.dispatchFetch('http://localhost/logs', { method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Triscord-Version': '0.9.39',
             'X-Triscord-Signals': 'decoder,screen-start', 'X-Triscord-Reason': 'auto', ...headers },
  body: typeof text === 'string' ? deflateSync(Buffer.from(text, 'utf8')) : text });
const admin = (path, init = {}, key = adminKey) => mf.dispatchFetch('http://localhost' + path, { ...init, headers: { Authorization: `Bearer ${key}` } });

try {
  const diego = await account('acc-diego', 'Diego'), ana = await account('acc-ana', 'Ana');
  const leaked = 'f'.repeat(64);
  const log = `19:43:08.103 video: asked the sender for a keyframe: decoder: COM video initialization HRESULT=2147549446 x1\n` +
              `19:50:09.414 capture: thumbnail 0 failed: Windows capture failed (0x80010106)\nsession ${leaked} diego@example.com\n`;

  assert.equal((await upload('0'.repeat(64), log)).status, 401, 'an unknown session cannot upload');
  assert.equal((await upload(diego, log, { 'X-Triscord-Signals': 'Bad Signal' })).status, 400, 'signals are validated');
  assert.equal((await upload(diego, log, { 'X-Triscord-Version': '0.9' })).status, 400, 'the version is validated');
  assert.equal((await upload(diego, log, { 'X-Triscord-Reason': 'other' })).status, 400, 'the reason is validated');
  assert.equal((await upload(diego, Buffer.from('not deflate'))).status, 400, 'a body that is not deflate is refused');
  assert.equal((await upload(diego, deflateSync(Buffer.alloc(3 * 1024 * 1024, 0x61)))).status, 413, 'a body that inflates past 1 MB is refused');
  console.log('ok: invalid uploads are refused');

  const sent = await upload(diego, log);
  assert.equal(sent.status, 201);
  const { id } = await sent.json();
  const stored = (await db.prepare('SELECT text FROM error_reports WHERE id = ?').bind(id).first()).text;
  assert.ok(stored.includes('COM video initialization') && stored.includes('<hex>') && stored.includes('<email>'));
  assert.ok(!stored.includes(leaked) && !stored.includes('diego@example.com'), 'tokens and e-mails are never stored');
  const row = await db.prepare('SELECT nick, version, signals, reason FROM error_reports WHERE id = ?').bind(id).first();
  assert.deepEqual({ ...row }, { nick: 'Diego', version: '0.9.39', signals: 'decoder,screen-start', reason: 'auto' });
  console.log('ok: a report is stored scrubbed, with its index row');

  assert.equal((await upload(diego, log, { 'X-Triscord-Reason': 'manual' })).status, 201);
  assert.equal((await upload(diego, log)).status, 201);
  assert.equal((await upload(diego, log)).status, 429, 'a fourth report within the hour is refused');
  assert.equal((await upload(ana, log)).status, 201, 'the limit is per account');
  console.log('ok: at most 3 reports per account per hour');

  const old = '00000000-0000-4000-8000-000000000000';
  await db.prepare('INSERT INTO error_reports(id,account_id,nick,version,signals,reason,bytes,created_at,text) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(old, 'acc-ana', 'Ana', '0.9.30', 'crash', 'auto', 3, Date.now() - 15 * 24 * 60 * 60 * 1000, 'old').run();
  assert.equal((await upload(ana, log)).status, 201);
  assert.equal(await db.prepare('SELECT 1 FROM error_reports WHERE id = ?').bind(old).first(), null, 'reports older than 14 days are deleted');
  console.log('ok: reports older than 14 days are removed');

  assert.equal((await admin('/admin/api/reports', {}, 'wrong-key-0123456789')).status, 401, 'a wrong key reads nothing');
  assert.equal((await mf.dispatchFetch('http://localhost/admin/api/reports')).status, 401, 'no key reads nothing');
  const list = await (await admin('/admin/api/reports')).json();
  assert.equal(list.reports.length, 5);
  assert.deepEqual(list.reports.find(r => r.id === id).signals, ['decoder', 'screen-start']);
  const text = await admin(`/admin/api/reports/${id}`);
  assert.equal(text.status, 200);
  assert.equal(await text.text(), stored);
  assert.equal((await admin(`/admin/api/reports/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await admin(`/admin/api/reports/${id}`)).status, 404);
  assert.equal(await db.prepare('SELECT 1 FROM error_reports WHERE id = ?').bind(id).first(), null);
  const page = await mf.dispatchFetch('http://localhost/admin');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.match(await page.text(), /Relatórios de erro/);
  assert.equal((await mf.dispatchFetch('http://localhost/admin/app.js')).status, 200);
  console.log('ok: the admin API lists, opens and deletes reports only with the key');
  console.log('ERROR REPORTS TESTS PASSED');
} finally {
  await mf.dispose();
}
