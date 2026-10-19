import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

let mode = 'http-error', calls = 0;
const secret = 'local-fixture-secret-never-return-to-client';
const iceServers = [{ urls: ['turn:relay.example:3478?transport=udp'], username: 'fixture', credential: 'fixture-password' }];
const provider = createServer((_req, res) => {
  if (mode === 'timeout') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); return; }
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'http-error') { res.writeHead(401); res.end(JSON.stringify({ error: secret })); }
  else if (mode === 'invalid-json') res.end('{broken');
  else if (mode === 'invalid-servers') res.end(JSON.stringify({ iceServers: [{ urls: 'https://wrong.example' }] }));
  else if (mode === 'missing-credentials') res.end(JSON.stringify({ iceServers: [{ urls: 'turn:relay.example:3478' }] }));
  else setTimeout(() => res.end(JSON.stringify({ iceServers })), 50);
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
let mf;
try {
  mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0,
    script: readFileSync('out/recovery/worker.js', 'utf8'), modules: true, compatibilityDate: '2026-10-12',
    d1Databases: { DB: 'turn-recovery' }, durableObjects: { HUB: { className: 'TriscordHub', useSQLite: true } },
    bindings: { TURN_API_TOKEN: secret, TURN_TOKEN_ID: 'fixture' },
    outboundService(request) {
      calls++;
      assert.equal(new URL(request.url).host, 'rtc.live.cloudflare.com');
      assert.equal(request.headers.get('Authorization'), `Bearer ${secret}`);
      if (mode === 'network-error') throw new Error(secret);
      // Local fixture only. The production provider is never contacted.
      return fetch(`http://127.0.0.1:${provider.address().port}`);
    }
  }));
  const db = await mf.getD1Database('DB');
  for (const sql of readFileSync('../cloudflare-auth/schema.sql', 'utf8').replace(/--[^\n]*/g, '').split(';')
    .map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(sql);
  const token = 'e'.repeat(64);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
  await db.prepare('INSERT INTO accounts(id,email,created_at,updated_at) VALUES (?,?,?,?)').bind('turn', 'turn@example.com', 1, 1).run();
  await db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').bind(hash, 'turn', 1, Date.now() + 600000).run();
  const request = () => mf.dispatchFetch('http://localhost/ice', { headers: { Authorization: `Bearer ${token}` } });
  for (mode of ['http-error', 'invalid-json', 'invalid-servers', 'missing-credentials', 'network-error', 'timeout']) {
    const start = Date.now(), before = calls;
    const response = await request();
    assert.equal(response.status, 502, mode); assert.equal(calls, before + 1, 'failures must not populate cache');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'turn_unavailable' });
    assert(Date.now() - start < 9000, 'upstream timeout must bound the whole JSON response read');
    console.log(`PASS: TURN ${mode} returns bounded, sanitized 502 without caching the failure`);
  }
  mode = 'success'; const before = calls;
  const responses = await Promise.all(Array.from({ length: 12 }, () => request()));
  for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { iceServers }); }
  assert.equal(calls - before, 1, 'concurrent requests must share one upstream mint');
  assert.equal((await request()).status, 200); assert.equal(calls - before, 1);
  await db.prepare('DELETE FROM sessions WHERE account_id=?').bind('turn').run();
  assert.equal((await request()).status, 401); assert.equal(calls - before, 1, 'cached TURN credentials must still require a live session');
  console.log('PASS: provider recovery, twelve concurrent requests share one mint and later requests reuse valid cache');
} finally {
  try { await mf?.dispose(); }
  finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
}
