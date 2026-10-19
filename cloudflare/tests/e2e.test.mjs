// Local-only auth + hub integration, sharing a disposable D1 database.
// Optional Qt client: TRISCORD_NATIVE_API_TEST=<native-hub-api-tests.exe>.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, delimiter } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const clientId = 'local-e2e.apps.googleusercontent.com';
const key = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
const google = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'local-e2e', alg: 'RS256', use: 'sig' }] }));
});
await new Promise(resolve => google.listen(0, '127.0.0.1', resolve));
async function idToken(sub) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'RS256', kid: 'local-e2e' })}.${encode({ iss: 'https://accounts.google.com',
    aud: clientId, sub, email: `${sub}@example.com`, email_verified: true,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return data + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey,
    new TextEncoder().encode(data))).toString('base64url');
}
const ingress = `export default { fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/media/')) return env.AUTH.fetch(request);
  const auth = url.pathname.startsWith('/auth-service/');
  if (!auth && !url.pathname.startsWith('/hub-service/')) return new Response('Not found', {status:404});
  url.pathname = url.pathname.slice(auth ? 13 : 12);
  return (auth ? env.AUTH : env.CONTROL).fetch(new Request(url, request));
}}`;
let mf;
try {
  mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, workers: [
    { name: 'entry', modules: true, script: ingress, compatibilityDate: '2026-10-12',
      serviceBindings: { AUTH: 'auth', CONTROL: 'control' } },
    { name: 'auth', modules: true, script: readFileSync(resolve(root, process.env.TRISCORD_AUTH_TEST_BUNDLE || 'cloudflare-auth/out/worker.js'), 'utf8'),
      compatibilityDate: '2026-10-12', d1Databases: { DB: 'local-e2e-shared' },
      bindings: { GOOGLE_CLIENT_ID: clientId, GOOGLE_JWKS_URL: `http://127.0.0.1:${google.address().port}/certs` } },
    { name: 'control', modules: true, script: readFileSync(resolve(root, process.env.TRISCORD_CONTROL_TEST_BUNDLE || 'cloudflare/out/worker.js'), 'utf8'),
      compatibilityDate: '2026-10-12', d1Databases: { DB: 'local-e2e-shared' },
      durableObjects: { HUB: { className: 'TriscordHub', useSQLite: true } } }
  ] }));
  const origin = (await mf.ready).origin;
  const db = await mf.getD1Database('DB', 'auth');
  for (const path of ['cloudflare-auth/schema.sql', 'cloudflare/migrations/0001_servers.sql']) {
    for (const sql of readFileSync(resolve(root, path), 'utf8').replace(/--[^\n]*/g, '').split(';')
      .map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(sql);
  }
  async function request(service, path, { token, method = 'GET', body, bytes } = {}) {
    // workerd's local ingress resets some pooled Node 26 fetch connections.
    // Explicitly isolate HTTP connections; Qt exercises its own transport below.
    const headers = { Connection: 'close' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bytes) headers['Content-Type'] = 'image/png';
    const response = await fetch(`${origin}/${service}-service${path}`, { method, headers,
      body: bytes || (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(10000) })
      .catch(error => { throw new Error(`${method} ${service}${path}: transport failed`, { cause: error }); });
    const raw = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(raw.toString()) : raw };
  }
  async function login(id) {
    const result = await request('auth', '/auth/google', { method: 'POST', body: { id_token: await idToken(id) } });
    assert.equal(result.status, 200); assert(result.body.session); return result.body.session;
  }
  const alice = await login('e2e-alice'), bob = await login('e2e-bob'), outsider = await login('e2e-outsider');
  for (const [token, nick] of [[alice, 'Alice'], [bob, 'Bob']]) {
    assert.equal((await request('auth', '/nick', { token, method: 'POST', body: { nick } })).status, 200);
  }
  assert.equal((await request('auth', '/profile', { token: alice, method: 'PATCH',
    body: { bio: 'E2E profile', note: 'private fixture' } })).status, 200);
  const publicProfile = (await request('auth', '/profile/e2e-alice')).body.profile;
  assert.equal(publicProfile.bio, 'E2E profile'); assert.equal(publicProfile.note, undefined);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=', 'base64');
  const media = await request('auth', '/profile/avatar', { token: alice, method: 'PUT', bytes: png });
  assert.equal(media.status, 200);
  const mediaPath = new URL(media.body.media.url).pathname.replace(/^\/auth-service/, '');
  assert.deepEqual((await request('auth', mediaPath)).body, png);
  assert.equal((await request('auth', '/me', { token: bob })).body.account.avatar_url, null);
  const mediaRace = await Promise.all([
    request('auth', '/profile/avatar', { token: alice, method: 'PUT', bytes: png }),
    request('auth', '/profile/avatar', { token: alice, method: 'DELETE' })
  ]);
  assert(mediaRace.every(r => r.status === 200));
  const finalAccount = (await request('auth', '/me', { token: alice })).body.account;
  const finalAsset = await db.prepare('SELECT hash,size,length(data) AS bytes FROM profile_media WHERE account_id=? AND kind=?')
    .bind('e2e-alice', 'avatar').first();
  assert.equal(!!finalAccount.avatar_url, !!finalAsset, 'media row and account URL must agree after a write/delete race');
  if (finalAsset) {
    assert(finalAccount.avatar_url.endsWith(finalAsset.hash)); assert.equal(finalAsset.size, finalAsset.bytes);
  }
  const server = await request('hub', '/servers', { token: alice, method: 'POST', body: { name: 'E2E guild' } });
  assert.equal(server.status, 201); const serverId = server.body.id;
  assert.equal((await request('hub', `/servers/${serverId}`, { token: bob })).status, 403);
  const invite = await request('hub', `/servers/${serverId}/invites`, { token: alice, method: 'POST', body: { maxUses: 1 } });
  assert.equal(invite.status, 201);
  const accept = token => request('hub', `/invites/${invite.body.code}/accept`, { token, method: 'POST' });
  const race = await Promise.all([accept(bob), accept(outsider)]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 410]);
  const winner = race[0].status === 200 ? bob : outsider;
  assert.equal((await accept(winner)).status, 200);
  assert.equal((await db.prepare('SELECT uses FROM server_invites WHERE code=?').bind(invite.body.code).first()).uses, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE server_id=?').bind(serverId).first()).n, 2);
  assert.equal((await request('hub', `/servers/${serverId}/invites`, { token: winner, method: 'POST', body: {} })).status, 403);
  const handshake = (token, extra = {}) => mf.dispatchFetch(`${origin}/hub-service/socket.io/?` +
    new URLSearchParams({ EIO: '4', transport: 'websocket', serverId, ...(token ? { sessionToken: token } : {}) }),
    { headers: { Upgrade: 'websocket', ...extra } });
  assert.equal((await handshake(race[0].status === 200 ? outsider : bob)).status, 403);
  assert.equal((await handshake('', { 'X-Triscord-Verified-Identity': JSON.stringify({ accountId: 'e2e-alice' }) })).status, 401);
  const expired = await login('expired-fixture');
  await db.prepare('UPDATE sessions SET expires_at=0 WHERE account_id=?').bind('expired-fixture').run();
  assert.equal((await request('auth', '/me', { token: expired })).status, 401);
  assert.equal((await request('hub', '/servers', { token: expired })).status, 401);
  assert.equal((await handshake(expired)).status, 401);
  // Concurrent nickname claims must yield a conflict, never an internal error.
  for (let round = 0; round < 4; round++) {
    const nick = `ContestedNick${round}`;
    const nickRace = await Promise.all([bob, outsider].map((token, index) => request('auth', '/nick', {
      token, method: 'POST', body: { nick: index ? nick.toLowerCase() : nick } })));
    assert.deepEqual(nickRace.map(r => r.status).sort(), [200, 409]);
    assert.equal(nickRace.find(r => r.status === 409).body.error, 'nick_taken');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE nick_lower=?').bind(nick.toLowerCase()).first()).n, 1);
  }
  // Same account logging in simultaneously must not race the first INSERT.
  const concurrentToken = await idToken('concurrent-new-account');
  const firstLogins = await Promise.all(Array.from({ length: 8 }, () => request('auth', '/auth/google', {
    method: 'POST', body: { id_token: concurrentToken } })));
  assert(firstLogins.every(r => r.status === 200), 'concurrent first logins must succeed');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE id=?').bind('concurrent-new-account').first()).n, 1);
  const native = process.env.TRISCORD_NATIVE_API_TEST || (process.argv.includes('--native')
    ? resolve(root, 'desktop/out/build/native-hub-api-tests.exe') : null);
  if (native) {
    // Only generated fixture credentials; never read the real user's session/settings.
    const report = resolve(root, 'desktop/out/backend-e2e/native.txt');
    assert(existsSync(native), 'Build native-hub-api-tests before running the native E2E');
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, '');
    const child = spawn(resolve(native), ['endToEndWorkers', '-o', report + ',txt'], { windowsHide: true, stdio: 'inherit',
      env: { ...process.env, TRISCORD_AUTH_SERVER: `${origin}/auth-service`,
        PATH: [resolve(root, '.toolchain/Qt/6.8.3/mingw_64/bin'), resolve(root, '.toolchain/Qt/Tools/mingw1310_64/bin'), process.env.PATH].join(delimiter),
        TRISCORD_E2E_HUB: `${origin}/hub-service`, TRISCORD_E2E_TOKEN_A: await idToken('qt-alice'),
        TRISCORD_E2E_TOKEN_B: await idToken('qt-bob') } });
    const timer = setTimeout(() => child.kill(), 60000);
    try {
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      console.log(readFileSync(report, 'utf8'));
      assert.equal(code, 0, 'Qt client E2E failed or timed out');
    } finally { clearTimeout(timer); }
  } else console.log('SKIP: Qt client (set TRISCORD_NATIVE_API_TEST to enable)');
  assert.equal((await request('auth', '/logout', { token: alice, method: 'POST' })).status, 200);
  for (const [service, path] of [['auth', '/me'], ['hub', '/servers'], ['hub', '/ice']]) {
    assert.equal((await request(service, path, { token: alice })).status, 401, `logout revocation ${service}${path}`);
  }
  assert.equal((await request('auth', '/profile/avatar', { token: alice, method: 'PUT', bytes: png })).status, 401);
  assert.equal((await handshake(alice)).status, 401);
  console.log('PASS: both Workers/shared D1; signed/concurrent login; profile/privacy; media bytes/write-delete race; server permissions; invite/nickname races and DB invariants; expired/revoked sessions and forged WebSocket identity');
} finally {
  try { await mf?.dispose(); } finally { await new Promise(resolve => google.close(resolve)); }
}
