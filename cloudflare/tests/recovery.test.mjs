// Fault injection against real local workerd, D1 and hibernating Durable Objects.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';

const control = readFileSync('out/recovery/worker.js', 'utf8');
const auth = readFileSync('../cloudflare-auth/out/recovery/worker.js', 'utf8');
// Only this test bundle exports the probe. No testing routes enter production.
const probe = `export class FailureProbe extends TriscordHub {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if(path === '/probe/alarm') { await this.alarm(); return Response.json({ok:true}); }
    if(path === '/probe/state') return Response.json({rooms:this.directory(),
      history:this.history('recovery'), attachments:[...this.clients.values()].map(c=>c.data)});
    return super.fetch(request);
  }
}`;
class Client {
  constructor(ws) {
    this.ws = ws; this.packets = []; this.waiters = [];
    this.closed = new Promise(resolve => ws.addEventListener('close', e => resolve(e.code)));
    ws.addEventListener('message', e => { this.packets.push(e.data); this.flush(); }); ws.accept();
  }
  flush() {
    for (const w of [...this.waiters]) {
      const i = this.packets.findIndex(w.test); if (i < 0) continue;
      this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(this.packets.splice(i, 1)[0]);
    }
  }
  packet(test) {
    return new Promise((resolve, reject) => {
      const w = { test, resolve, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error('Recovery packet timeout'));
      }, 4000) }; this.waiters.push(w); this.flush();
    });
  }
  send(name, data) { this.ws.send('42' + JSON.stringify([name, data])); }
  async event(name) {
    return JSON.parse((await this.packet(p => typeof p === 'string' && p.startsWith('42[') && JSON.parse(p.slice(2))[0] === name)).slice(2))[1];
  }
  async join() {
    this.send('join-room', { roomId: 'recovery', userData: { userId: 'forged', username: 'Forged', sessionToken: this.token } });
    return this.event('room-joined');
  }
  async expectClosed(code) {
    let timer;
    try { assert.equal(await Promise.race([this.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Revoked socket remained open')), 4000);
    })]), code); } finally { clearTimeout(timer); }
  }
  close() { try { this.ws.close(1000); } catch {} }
}
const directory = mkdtempSync(resolve(tmpdir(), 'triscord-recovery-'));
let mf; const clients = [];
const options = () => convertV4MiniflareOptions({ host: '127.0.0.1', port: 0,
  resourcePersistencePath: directory, workers: [
    { name: 'control', script: control + '\n' + probe, modules: true, compatibilityDate: '2026-10-12',
      bindings: { INVITE_CODE: 'local-recovery-invite-only' },
      d1Databases: { DB: 'recovery-shared' }, durableObjects: { HUB: { className: 'FailureProbe', useSQLite: true } } },
    { name: 'auth', script: auth, modules: true, compatibilityDate: '2026-10-12', d1Databases: { DB: 'recovery-shared' } }
  ] });
async function seed(db, id, digit) {
  const token = digit.repeat(64), hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
  await db.prepare('INSERT OR IGNORE INTO accounts(id,email,nick,nick_lower,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .bind(id, `${id}@example.com`, id, id.toLowerCase(), Date.now(), Date.now()).run();
  await db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?)').bind(hash, id, Date.now(), Date.now() + 600000).run();
  return token;
}
async function connect(token, serverId) {
  const response = await mf.dispatchFetch('http://localhost/socket.io/?' + new URLSearchParams({
    EIO: '4', transport: 'websocket', ...(serverId ? { sessionToken: token, serverId } : {}) }), { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const c = new Client(response.webSocket); c.token = token; clients.push(c);
  await c.packet(p => p.startsWith('0')); c.ws.send('40' + JSON.stringify({ invite: 'local-recovery-invite-only' }));
  await c.packet(p => p.startsWith('40'));
  return c;
}
async function probeState(id, path = '/probe/state') {
  const ns = await mf.getDurableObjectNamespace('HUB', 'control');
  return (await ns.get(ns.idFromName(id)).fetch('http://probe' + path)).json();
}
try {
  mf = new Miniflare(options()); await mf.ready;
  let db = await mf.getD1Database('DB', 'control');
  for (const file of ['../cloudflare-auth/schema.sql', 'migrations/0001_servers.sql']) {
    for (const sql of readFileSync(file, 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(sql);
  }
  const a = await seed(db, 'Alice', 'a'), b = await seed(db, 'Bob', 'b');
  const headers = { Authorization: `Bearer ${a}`, 'Content-Type': 'application/json' };
  const created = await mf.dispatchFetch('http://localhost/servers', { method: 'POST', headers, body: JSON.stringify({ name: 'Recovery' }) });
  assert.equal(created.status, 201); const serverId = (await created.json()).id;
  await db.prepare('INSERT INTO server_members VALUES (?,?,?)').bind(serverId, 'Bob', Date.now()).run();
  const alice = await connect(a, serverId), bob = await connect(b, serverId);
  await alice.join(); await bob.join();
  alice.send('send-chat-message', { message: 'preserved across restarts' });
  const message = await bob.event('new-chat-message');
  const authWorker = await mf.getWorker('auth');
  assert.equal((await authWorker.fetch('http://auth/logout', { method: 'POST', headers })).status, 200);
  alice.send('send-chat-message', { message: 'must never persist after logout' });
  await alice.expectClosed(1008);
  let state = await probeState(serverId);
  assert.deepEqual(state.history.map(m => m.text), ['preserved across restarts']);
  assert(!state.rooms.flatMap(r => r.users).some(u => u.userId === 'Alice'));
  assert.equal(state.rooms.find(r => r.id === 'recovery').ownerUserId, 'Bob');
  console.log('PASS: logout blocks the next operation on an existing socket and removes room membership');

  const nextToken = await seed(db, 'Alice', 'c');
  const returning = await connect(nextToken, serverId); await returning.join();
  await db.prepare('UPDATE sessions SET expires_at=0 WHERE account_id=?').bind('Alice').run();
  await probeState(serverId, '/probe/alarm'); await returning.expectClosed(1008);
  const thirdToken = await seed(db, 'Alice', 'd');
  const removed = await connect(thirdToken, serverId); await removed.join();
  await db.prepare('DELETE FROM server_members WHERE server_id=? AND account_id=?').bind(serverId, 'Alice').run();
  removed.send('send-chat-message', { message: 'must not persist after membership removal' });
  await removed.expectClosed(1008);
  console.log('PASS: idle session expiry on alarm and membership removal revoke active sockets');

  const legacyToken = await seed(db, 'Legacy', 'f'), legacy = await connect(legacyToken);
  await legacy.join();
  assert.equal((await authWorker.fetch('http://auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${legacyToken}` } })).status, 200);
  legacy.send('send-chat-message', { message: 'legacy must not downgrade to guest after logout' });
  await legacy.expectClosed(1008);
  console.log('PASS: authenticated legacy Qt connection pins its session and cannot downgrade after logout');

  await mf.unsafeEvictDurableObject('control', 'FailureProbe', { name: serverId, webSockets: 'hibernate' });
  bob.send('add-reaction', { messageId: message.id, emoji: '👍' });
  assert.deepEqual((await bob.event('message-reaction-updated')).reactions['👍'], ['Bob']);
  state = await probeState(serverId);
  assert.equal(state.history.length, 1);
  assert.equal(state.rooms.find(r => r.id === 'recovery').users.length, 1);
  assert(!JSON.stringify(state.attachments).includes(b), 'never persist bearer tokens in websocket attachments');
  assert.match(state.attachments[0].identity.sessionHash, /^[0-9a-f]{64}$/);
  assert.equal(state.attachments[0].identity.serverId, serverId);
  console.log('PASS: real DO eviction/hibernation restores sockets, identity, history and one membership without duplicates');

  await db.exec('ALTER TABLE sessions RENAME TO sessions_offline');
  const unavailable = await mf.dispatchFetch('http://localhost/servers', { headers: { Authorization: `Bearer ${b}` } });
  assert.equal(unavailable.status, 503); assert.deepEqual(await unavailable.json(), { error: 'service_unavailable' });
  const authUnavailable = await authWorker.fetch('http://auth/me', { headers: { Authorization: `Bearer ${b}` } });
  assert.equal(authUnavailable.status, 503); assert.deepEqual(await authUnavailable.json(), { error: 'service_unavailable' });
  bob.send('add-reaction', { messageId: message.id, emoji: '👍' }); await bob.expectClosed(1013);
  await db.exec('ALTER TABLE sessions_offline RENAME TO sessions');
  const recovered = await connect(b, serverId);
  assert.equal((await recovered.join()).chatHistory.length, 1);
  console.log('PASS: unavailable D1 fails closed with sanitized 503/retryable socket close and recovers without data loss');

  for (const c of clients) c.close();
  await mf.dispose(); mf = new Miniflare(options()); await mf.ready;
  db = await mf.getD1Database('DB', 'control');
  const afterRestart = await connect(b, serverId), room = await afterRestart.join();
  assert.equal(room.chatHistory.length, 1); assert.equal(room.chatHistory[0].id, message.id);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE server_id=?').bind(serverId).first()).n, 1);
  console.log('PASS: full local runtime restart retains D1 membership, DO history and usable session');
} finally {
  for (const c of clients) c.close();
  await mf?.dispose();
  // Verify the exact generated target before recursive cleanup on Windows.
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert(basename(target).startsWith('triscord-recovery-'));
  rmSync(target, { recursive: true, force: true });
}
