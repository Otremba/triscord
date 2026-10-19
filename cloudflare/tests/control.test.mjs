import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const invite = 'local-test-private-group-code';
const bundlePath = resolve(process.env.TRISCORD_CONTROL_TEST_BUNDLE || 'out/worker.js');
const mf = new Miniflare(convertV4MiniflareOptions({ scriptPath: bundlePath, modules: true,
  compatibilityDate: '2026-10-12', host: '127.0.0.1', port: 0,
  durableObjects: { HUB: { className: 'TriscordHub', useSQLite: true } }, bindings: { INVITE_CODE: invite },
  d1Databases: { DB: 'triscord-accounts-test' } }));

const db = await mf.getD1Database('DB');
{
  // Same schema the real triscord-accounts D1 database uses (cloudflare-auth/schema.sql),
  // seeded here so the hub's session lookups exercise real D1 query behaviour.
  const schema = readFileSync(resolve('../cloudflare-auth/schema.sql'), 'utf8');
  const statements = schema.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const statement of statements) await db.exec(statement);
  // This hub's own additive migration (servers/server_members/server_invites),
  // applied the same way the auth worker's own schema is above.
  const serversSchema = readFileSync(resolve('migrations/0001_servers.sql'), 'utf8');
  const serverStatements = serversSchema.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const statement of serverStatements) await db.exec(statement);
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function seedAccount({ id, nick = null, nickLower = null, tokenHex, expiresInMs = 30 * 24 * 60 * 60 * 1000 }) {
  const now = Date.now();
  await db.prepare('INSERT INTO accounts(id, email, nick, nick_lower, avatar_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, `${id}@example.com`, nick, nickLower, null, now, now).run();
  if (tokenHex) {
    const hash = await sha256Hex(tokenHex);
    await db.prepare('INSERT INTO sessions(token_hash, account_id, created_at, expires_at) VALUES (?,?,?,?)')
      .bind(hash, id, now, now + expiresInMs).run();
  }
}
class Client {
  constructor(socket) {
    this.socket = socket; this.packets = []; this.waiters = [];
    socket.addEventListener('message', event => { this.packets.push(event.data); this.flush(); });
    socket.accept();
  }
  flush() {
    for (const waiter of [...this.waiters]) {
      const index = this.packets.findIndex(waiter.test);
      if (index < 0) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(this.packets.splice(index, 1)[0]);
    }
  }
  packet(test) { return new Promise((resolve, reject) => {
    const waiter = { test, resolve, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(waiter),1); reject(new Error('Control event timeout')); }, 3000) };
    this.waiters.push(waiter); this.flush();
  }); }
  send(name, payload) { this.socket.send('42' + JSON.stringify([name, payload])); }
  async event(name) {
    const packet = await this.packet(value => typeof value === 'string' && value.startsWith('42[') && JSON.parse(value.slice(2))[0] === name);
    return JSON.parse(packet.slice(2))[1];
  }
  async auth(code = invite) {
    await this.packet(value => value.startsWith('0'));
    this.socket.send('40' + JSON.stringify({ invite: code }));
    const ready = await this.packet(value => value.startsWith('40') || value.startsWith('44'));
    if (ready.startsWith('44')) return false;
    this.sid = JSON.parse(ready.slice(2)).sid; return true;
  }
  async join(room, userId, extra = {}) {
    this.send('join-room', { roomId: room, userData: { userId, username: userId, isMuted: false, isScreenSharing: true }, ...extra });
    return this.event('room-joined');
  }
  close() { try { this.socket.close(1000,'Test done'); } catch {} }
}
const clients = [];
async function connect() {
  const response = await mf.dispatchFetch('http://localhost/socket.io/?EIO=4&transport=websocket', { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status,101); const client = new Client(response.webSocket); clients.push(client); return client;
}
// Raw handshake response (no 101 assertion / no Client wrapping) so routing
// rejections (401/403/400) can be inspected directly.
async function handshake(params = {}) {
  const qs = new URLSearchParams({ EIO: '4', transport: 'websocket', ...params });
  return mf.dispatchFetch(`http://localhost/socket.io/?${qs}`, { headers: { Upgrade: 'websocket' } });
}
async function connectToServer(serverId, sessionToken) {
  const response = await handshake({ serverId, sessionToken });
  assert.equal(response.status, 101);
  const client = new Client(response.webSocket); clients.push(client); return client;
}
async function api(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return mf.dispatchFetch(`http://localhost${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function ownDirectoryUser(client, roomId) {
  const packet = await client.packet(value => {
    if (!value.startsWith('42[')) return false;
    const [event, rooms] = JSON.parse(value.slice(2));
    return event === 'rooms-update' && rooms.some(r => r.id === roomId && r.users.some(u => u.socketId === client.sid));
  });
  return JSON.parse(packet.slice(2))[1].find(r => r.id === roomId).users.find(u => u.socketId === client.sid);
}
try {
  assert.equal((await mf.dispatchFetch('http://localhost/')).status, 200);
  assert.equal((await mf.dispatchFetch('http://localhost/socket.io/?EIO=4&transport=polling')).status,404);
  const bad = await connect(); assert.equal(await bad.auth('wrong-code'),false);
  const a = await connect(), b = await connect(), c = await connect();
  for (const client of [a,b,c]) assert(await client.auth());
  assert.equal((await a.join('geral','profile_a')).isOwner,true);
  assert.equal((await b.join('geral','profile_b')).isOwner,false);
  assert.equal((await c.join('jogos','profile_a')).isOwner,true);
  a.send('send-chat-message',{ roomId:'geral', message:'hello', imageData:'ignored' });
  const chat = await b.event('new-chat-message'); assert.equal(chat.text,'hello'); assert.equal(chat.imageData,undefined);
  b.send('add-reaction',{ messageId:chat.id, emoji:'👍' });
  const reaction = await a.event('message-reaction-updated'); assert.deepEqual(reaction.reactions['👍'],['profile_b']);
  b.send('delete-chat-message', { messageId: chat.id, senderUserId: 'profile_a' });
  assert.match((await b.event('request-error')).message, /próprias/);
  const soundId = '0a62899441f1b2bc7171700f7df77c65f31082261c836cdf9c1bb756459e8e67';
  a.send('soundboard-play', { soundId });
  const sound = await b.event('soundboard-played');
  assert.equal(sound.soundId, soundId); assert.equal(sound.roomId, 'geral');
  assert.equal((await a.event('soundboard-played')).bySocketId, a.sid);
  assert(!c.packets.some(packet => packet.includes('soundboard-played')));
  a.send('soundboard-play', { soundId }); assert.match((await a.event('request-error')).message, /aguarde/);
  a.send('delete-chat-message', { messageId: chat.id });
  assert.equal((await b.event('chat-message-deleted')).messageId, chat.id);
  a.send('webrtc-offer',{ targetSocketId:b.sid,type:'native-screen',session:crypto.randomUUID(),offer:{type:'offer',sdp:'native-test',video:{width:640,height:360,fps:30,bitrate:1000000}} });
  const offer = await b.event('webrtc-offer'); assert.equal(offer.senderSocketId,a.sid); assert.equal(offer.type,'native-screen'); assert.equal(offer.offer.video.width,640);
  a.send('screen-watch', { targetSocketId: b.sid, watching: false });
  assert.deepEqual(await b.event('screen-watch'), { senderSocketId: a.sid, watching: false });
  a.send('screen-watch', { targetSocketId: b.sid, watching: true });
  assert.deepEqual(await b.event('screen-watch'), { senderSocketId: a.sid, watching: true });
  a.send('user-state-change',{ isScreenSharing:true,pcHealth:{cpu:100},socketId:'spoof',userId:'spoof' });
  const state = await b.event('user-state-updated'); assert.deepEqual(state.state,{isScreenSharing:true});
  a.send('webrtc-offer',{ targetSocketId:b.sid,type:'native-camera',session:crypto.randomUUID(),offer:{type:'offer',sdp:'camera-test',video:{width:640,height:360,fps:30,bitrate:1000000}} });
  const cameraOffer = await b.event('webrtc-offer'); assert.equal(cameraOffer.type,'native-camera'); assert.equal(cameraOffer.senderSocketId,a.sid);
  a.send('camera-watch', { targetSocketId: b.sid, watching: false });
  assert.deepEqual(await b.event('camera-watch'), { senderSocketId: a.sid, watching: false });
  a.send('user-state-change', { isCameraOn: true });
  assert.deepEqual((await b.event('user-state-updated')).state, { isCameraOn: true });
  a.send('update-room-settings',{locked:true,maxUsers:2});
  await a.event('rooms-update'); // Earlier directory broadcasts may still be buffered.
  c.send('join-room',{roomId:'geral',userData:{userId:'profile_c',username:'guest'}});
  await c.event('room-join-denied');
  a.send('force-mute-user',{socketId:b.sid}); await b.event('force-muted');
  b.send('user-state-change', { isMuted: false, isSpeaking: true, isServerMuted: false });
  assert.equal((await b.event('force-muted')).muted, true);
  await a.packet(packet => {
    if (!packet.startsWith('42[')) return false;
    const [event, data] = JSON.parse(packet.slice(2));
    return event === 'user-state-updated' && data.socketId === b.sid && data.state.isMuted === true && data.state.isSpeaking === false;
  });
  a.send('update-room-settings', { locked: false }); b.send('leave-room', {});
  await a.packet(packet => packet.startsWith('42[') && JSON.parse(packet.slice(2))[0] === 'rooms-update' && JSON.parse(packet.slice(2))[1].some(room => room.id === 'geral' && room.userCount === 1));
  const freshB = await connect(); assert(await freshB.auth());
  assert.equal((await freshB.join('geral', 'profile_b')).isServerMuted, true);
  freshB.send('force-mute-user', { socketId: freshB.sid, muted: false });
  freshB.send('user-state-change', { isMuted: false });
  assert.equal((await freshB.event('force-muted')).muted, true);
  a.send('force-mute-user', { socketId: freshB.sid, muted: false });
  assert.equal((await freshB.event('force-muted')).muted, false);
  a.send('kick-user',{socketId:freshB.sid}); await freshB.event('kicked');
  a.close(); await new Promise(resolve => setTimeout(resolve,50));
  const rejoined = await c.join('geral','profile_c'); assert.equal(rejoined.chatHistory.length,0); assert.equal(rejoined.isOwner,true);
  const fixture = await c.join('native-validation', 'profile_c');
  assert.equal(fixture.chatHistory.length, 0);
  c.send('send-chat-message', { message: 'temporary acceptance fixture' });
  await c.event('new-chat-message');
  c.send('leave-room', {});
  const cleaned = await c.packet(packet => {
    if (!packet.startsWith('42[')) return false;
    const [event, rooms] = JSON.parse(packet.slice(2));
    return event === 'rooms-update' && !rooms.some(room => room.id === 'native-validation');
  });
  assert(cleaned);
  assert.equal((await c.join('native-validation', 'profile_c')).chatHistory.length, 0);
  c.send('leave-room', {});
  console.log('PASS: private invite, native protocol, rooms/chat/reactions, typed signaling, role isolation, moderation and persistent bounded history');

  // --- Session-derived identity ---
  const kevinToken = 'f'.repeat(64), noNickToken = 'e'.repeat(64), expiredToken = '1'.repeat(64);
  await seedAccount({ id: 'acct-kevin', nick: 'KevinReal', nickLower: 'kevinreal', tokenHex: kevinToken });
  await seedAccount({ id: 'acct-nonick', nick: null, nickLower: null, tokenHex: noNickToken });
  await seedAccount({ id: 'acct-expired', nick: 'ExpiredGuy', nickLower: 'expiredguy', tokenHex: expiredToken, expiresInMs: -1000 });

  const observer = await connect(); assert(await observer.auth());
  await observer.join('identity', 'observer1');

  // A valid session resolves and the database nick wins over whatever name/id
  // the client sends in the same payload - this is the entire point of the task.
  const kevin = await connect(); assert(await kevin.auth());
  kevin.send('join-room', { roomId: 'identity', userData: { userId: 'client-claimed-id', username: 'ClientChosenName' }, sessionToken: kevinToken });
  await kevin.event('room-joined');
  const kevinJoined = await observer.event('user-joined');
  assert.equal(kevinJoined.userData.username, 'KevinReal');
  assert.notEqual(kevinJoined.userData.username, 'ClientChosenName');
  assert.equal(kevinJoined.userData.userId, 'acct-kevin'); // client-claimed id ignored too
  assert.equal(kevinJoined.userData.authenticated, true);
  kevin.send('leave-room', {});

  // Signed in but no nick chosen yet -> a clear placeholder, never null/empty.
  const noNick = await connect(); assert(await noNick.auth());
  noNick.send('join-room', { roomId: 'identity', userData: { userId: 'ignored', username: 'ignored-too' }, sessionToken: noNickToken });
  await noNick.event('room-joined');
  const noNickJoined = await observer.event('user-joined');
  assert.equal(noNickJoined.userData.username, 'Sem apelido');
  assert.equal(noNickJoined.userData.authenticated, true);
  noNick.send('leave-room', {});

  // Expired session -> downgraded to an unauthenticated guest (not rejected:
  // older native clients that don't yet send sessionToken must keep working),
  // but the guest keeps its own client-sent name since it doesn't collide
  // with a registered nick.
  const expired = await connect(); assert(await expired.auth());
  expired.send('join-room', { roomId: 'identity', userData: { userId: 'guest-1', username: 'GuestName' }, sessionToken: expiredToken });
  await expired.event('room-joined');
  const expiredJoined = await observer.event('user-joined');
  assert.equal(expiredJoined.userData.username, 'GuestName');
  assert.equal(expiredJoined.userData.authenticated, false);
  expired.send('leave-room', {});

  // Garbage/malformed session token -> same guest downgrade, not a crash or silent pass-through.
  const garbage = await connect(); assert(await garbage.auth());
  garbage.send('join-room', { roomId: 'identity', userData: { userId: 'guest-2', username: 'AnotherGuest' }, sessionToken: 'not-a-real-token' });
  await garbage.event('room-joined');
  const garbageJoined = await observer.event('user-joined');
  assert.equal(garbageJoined.userData.username, 'AnotherGuest');
  assert.equal(garbageJoined.userData.authenticated, false);
  garbage.send('leave-room', {});

  // No session at all, and the guest tries to claim a name that matches a
  // real registered account (case-insensitively) -> the impersonation attempt
  // is rejected by renaming, not honoured.
  const impersonator = await connect(); assert(await impersonator.auth());
  impersonator.send('join-room', { roomId: 'identity', userData: { userId: 'guest-3', username: 'kevinreal' } });
  await impersonator.event('room-joined');
  const impersonatorJoined = await observer.event('user-joined');
  assert.equal(impersonatorJoined.userData.username, 'Convidado');
  assert.notEqual(impersonatorJoined.userData.username, 'kevinreal');
  assert.equal(impersonatorJoined.userData.authenticated, false);
  impersonator.send('leave-room', {});

  for (const client of clients) client.close();
  console.log('PASS: session-derived identity overrides client-sent names, expired/garbage sessions downgrade to clearly-marked guests, guests cannot claim registered nicks, missing-nick accounts get a placeholder');

  // --- Servers (guilds): directory, membership, invites, per-server DOs ---
  const aliceToken = '2'.repeat(64), bobToken = '3'.repeat(64);
  await seedAccount({ id: 'acct-alice', nick: 'Alice', nickLower: 'alice', tokenHex: aliceToken });
  await seedAccount({ id: 'acct-bob', nick: 'Bob', nickLower: 'bob', tokenHex: bobToken });

  // No session at all -> 401, not a crash or a silent default identity.
  assert.equal((await api('/servers', { method: 'POST', body: { name: 'No Session' } })).status, 401);

  // Create a server: creator becomes owner and first member.
  const createRes = await api('/servers', { method: 'POST', token: aliceToken, body: { name: 'Alice Guild' } });
  assert.equal(createRes.status, 201);
  const serverA = await createRes.json();
  assert.equal(serverA.ownerAccountId, 'acct-alice');

  const bobServer = await api('/servers', { method: 'POST', token: bobToken, body: { name: 'Bob Guild' } });
  const serverB = await bobServer.json();

  // GET /servers lists only the servers the signed-in account belongs to.
  const aliceServers = await (await api('/servers', { token: aliceToken })).json();
  assert(aliceServers.servers.some(s => s.id === serverA.id));
  assert(!aliceServers.servers.some(s => s.id === serverB.id));

  // GET /servers/:id: creator (member+owner) sees the detail and is listed as a member.
  const detailRes = await api(`/servers/${serverA.id}`, { token: aliceToken });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.ownerAccountId, 'acct-alice');
  assert(detail.members.some(m => m.accountId === 'acct-alice'));

  // A non-member is rejected from GET /servers/:id.
  assert.equal((await api(`/servers/${serverA.id}`, { token: bobToken })).status, 403);

  // Only the owner may create invites - a non-owner (member or not) gets 403.
  assert.equal((await api(`/servers/${serverA.id}/invites`, { method: 'POST', token: bobToken, body: {} })).status, 403);

  // Owner creates an invite; code comes from crypto.getRandomValues (32 hex chars = 16 bytes).
  const inviteRes = await api(`/servers/${serverA.id}/invites`, { method: 'POST', token: aliceToken, body: {} });
  assert.equal(inviteRes.status, 201);
  const invite = await inviteRes.json();
  assert.match(invite.code, /^[0-9a-f]{32}$/);

  // Accepting the invite adds membership.
  const acceptRes = await api(`/invites/${invite.code}/accept`, { method: 'POST', token: bobToken });
  assert.equal(acceptRes.status, 200);
  assert.equal((await acceptRes.json()).serverId, serverA.id);
  const detailAfterAccept = await (await api(`/servers/${serverA.id}`, { token: bobToken })).json();
  assert(detailAfterAccept.members.some(m => m.accountId === 'acct-bob'));
  assert.equal((await api(`/invites/${invite.code}/accept`, { method: 'POST', token: bobToken })).status, 200);
  assert.equal((await db.prepare('SELECT uses FROM server_invites WHERE code=?').bind(invite.code).first()).uses, 1);

  // Actual Qt payload: the session is nested in userData, not at the root.
  const qtLegacy = await connect(); assert(await qtLegacy.auth());
  await qtLegacy.join('qt-contract', 'spoofed-id', {
    userData: { userId: 'spoofed-id', username: 'Spoofed', sessionToken: aliceToken }
  });
  const qtIdentity = await ownDirectoryUser(qtLegacy, 'qt-contract');
  assert.equal(qtIdentity.userId, 'acct-alice');
  assert.equal(qtIdentity.authenticated, true);
  qtLegacy.send('leave-room', {});

  // An expired invite fails (seeded directly: expiresInMs must be positive
  // through the API, so an already-expired row is inserted straight into D1,
  // exactly like a real invite would look once its expiry had passed).
  await db.prepare('INSERT INTO server_invites(code,server_id,created_by,created_at,expires_at,max_uses,uses) VALUES (?,?,?,?,?,?,0)')
    .bind('e'.repeat(32), serverA.id, 'acct-alice', Date.now() - 1000, Date.now() - 1, null).run();
  assert.equal((await api(`/invites/${'e'.repeat(32)}/accept`, { method: 'POST', token: aliceToken })).status, 410);

  // Exhausted invites still work for existing members, without consuming
  // another use; an outsider cannot use one.
  await db.prepare('INSERT INTO server_invites(code,server_id,created_by,created_at,expires_at,max_uses,uses) VALUES (?,?,?,?,?,?,?)')
    .bind('f'.repeat(32), serverA.id, 'acct-alice', Date.now(), null, 1, 1).run();
  assert.equal((await api(`/invites/${'f'.repeat(32)}/accept`, { method: 'POST', token: aliceToken })).status, 200);
  assert.equal((await api(`/invites/${'f'.repeat(32)}/accept`, { method: 'POST', token: kevinToken })).status, 410);

  // Two simultaneous attempts by one account must claim one use, and two
  // outsiders competing for the final use must admit just one of them.
  const limited = await (await api(`/servers/${serverB.id}/invites`, {
    method: 'POST', token: bobToken, body: { maxUses: 1 }
  })).json();
  const repeated = await Promise.all(Array.from({ length: 5 }, () => api(`/invites/${limited.code}/accept`, { method: 'POST', token: aliceToken })));
  assert(repeated.every(r => r.status === 200));
  assert.equal((await db.prepare('SELECT uses FROM server_invites WHERE code=?').bind(limited.code).first()).uses, 1);
  const contested = await (await api(`/servers/${serverB.id}/invites`, {
    method: 'POST', token: bobToken, body: { maxUses: 1 }
  })).json();
  const race = await Promise.all([kevinToken, noNickToken].map(token => api(`/invites/${contested.code}/accept`, { method: 'POST', token })));
  assert.deepEqual(race.map(r => r.status).sort(), [200, 410]);
  assert.equal((await db.prepare('SELECT uses FROM server_invites WHERE code=?').bind(contested.code).first()).uses, 1);

  // Creating an invite opportunistically removes expired rows from that
  // server, preserving current/indefinite invites.
  await api(`/servers/${serverA.id}/invites`, { method: 'POST', token: aliceToken, body: {} });
  assert.equal(await db.prepare('SELECT code FROM server_invites WHERE code=?').bind('e'.repeat(32)).first(), null);
  assert.ok(await db.prepare('SELECT code FROM server_invites WHERE code=?').bind(invite.code).first());

  // Unknown invite code also fails rather than crashing.
  assert.equal((await api(`/invites/${'0'.repeat(32)}/accept`, { method: 'POST', token: aliceToken })).status, 410);

  // Leaving and deleting a server.
  const temp = await (await api('/servers', { method: 'POST', token: aliceToken, body: { name: 'Temp Guild' } })).json();
  const tempInvite = await (await api(`/servers/${temp.id}/invites`, { method: 'POST', token: aliceToken, body: {} })).json();
  assert.equal((await api(`/invites/${tempInvite.code}/accept`, { method: 'POST', token: bobToken })).status, 200);
  assert.equal((await api(`/servers/${temp.id}`, { method: 'DELETE', token: bobToken })).status, 403);      // not the owner
  assert.equal((await api(`/servers/${temp.id}/leave`, { method: 'POST', token: aliceToken })).status, 409); // owner cannot leave
  assert.equal((await api(`/servers/${temp.id}/leave`, { method: 'POST', token: bobToken })).status, 200);
  assert.equal((await api(`/servers/${temp.id}`, { token: bobToken })).status, 403);
  assert.equal((await api(`/servers/${temp.id}/leave`, { method: 'POST', token: bobToken })).status, 403);   // no longer a member
  assert.equal((await api(`/servers/${temp.id}`, { method: 'DELETE', token: aliceToken })).status, 200);
  assert.equal((await api(`/servers/${temp.id}`, { token: aliceToken })).status, 403);
  assert.ok(!(await (await api('/servers', { token: aliceToken })).json()).servers.some(s => s.id === temp.id));
  for (const table of ['servers', 'server_members', 'server_invites'])
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'servers' ? 'id' : 'server_id'}=?`).bind(temp.id).first()).n, 0);
  assert.equal((await api(`/servers/${temp.id}`, { method: 'DELETE', token: aliceToken })).status, 404);
  assert.equal((await handshake({ serverId: temp.id, sessionToken: aliceToken })).status, 403);

  // --- WebSocket routing: per-server Durable Objects ---
  // A non-member cannot get a socket into someone else's server.
  const forbiddenWs = await handshake({ serverId: serverA.id, sessionToken: noNickToken });
  assert.equal(forbiddenWs.status, 403);
  // No/garbage session with a serverId present -> 401, never silently routed.
  assert.equal((await handshake({ serverId: serverA.id })).status, 401);
  assert.equal((await handshake({ serverId: serverA.id, sessionToken: 'not-a-real-token' })).status, 401);

  // Two different server ids get two isolated Durable Objects: a room
  // created in one is invisible from the other.
  const inA = await connectToServer(serverA.id, aliceToken);
  assert(await inA.auth('')); // Qt sends no legacy group invite for a server.
  await inA.join('geral', 'spoofed-id', { sessionToken: bobToken });
  const pinned = await ownDirectoryUser(inA, 'geral');
  assert.equal(pinned.userId, 'acct-alice');
  assert.equal(pinned.authenticated, true);
  const inB = await connectToServer(serverB.id, bobToken);
  assert(await inB.auth());
  const bRoomsUpdate = await inB.event('rooms-update'); // this DO's own initial directory, from its own constructor broadcast
  assert(!bRoomsUpdate.some(r => r.id === 'geral' && r.users.some(u => u.userId === 'acct-alice')));
  inA.send('leave-room', {}); inB.send('leave-room', {});

  // An externally forged forwarding header must never bypass the legacy
  // invite or the outer Worker's server membership checks.
  const forged = { Upgrade: 'websocket', 'X-Triscord-Verified-Identity': JSON.stringify({ accountId: 'acct-alice', nick: 'Alice' }) };
  const forgedLegacyResponse = await mf.dispatchFetch('http://localhost/socket.io/?EIO=4&transport=websocket', { headers: forged });
  const forgedLegacy = new Client(forgedLegacyResponse.webSocket); clients.push(forgedLegacy);
  assert.equal(await forgedLegacy.auth(''), false);
  assert.equal((await mf.dispatchFetch(`http://localhost/socket.io/?EIO=4&transport=websocket&serverId=${serverA.id}`, { headers: forged })).status, 401);

  // A legacy connection with no serverId at all still reaches the original
  // 'private-group-v1' instance - the same instance every earlier test in
  // this file (none of which pass serverId) has been using all along, so
  // its rooms ('geral', 'jogos') and chat history above are still intact.
  const legacy = await connect();
  assert(await legacy.auth());
  const legacyJoined = await legacy.join('geral', 'profile_legacy-check');
  assert(Array.isArray(legacyJoined.chatHistory));
  legacy.send('leave-room', {});

  for (const client of clients) client.close();
  console.log('PASS: server directory, membership, invite creation/acceptance (atomic, expiry/max-uses enforced), owner-only invites, member-only server detail, per-server Durable Object isolation, legacy no-serverId connections still land on private-group-v1');

  // --- GET /ice: Cloudflare Realtime TURN credential minting ---
  {
    const fakeToken = 'fake-turn-api-token-never-sent-to-client';
    let upstreamCalls = 0;
    const stubIceServers = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'stub-user', credential: 'stub-cred' }];
    // outboundService intercepts every fetch() the worker makes - this is the
    // stub for rtc.live.cloudflare.com; the real TURN API is never contacted.
    const iceMf = new Miniflare(convertV4MiniflareOptions({ scriptPath: bundlePath, modules: true,
      compatibilityDate: '2026-10-12', host: '127.0.0.1', port: 0,
      durableObjects: { HUB: { className: 'TriscordHub', useSQLite: true } },
      bindings: { INVITE_CODE: invite, TURN_API_TOKEN: fakeToken, TURN_TOKEN_ID: 'fake-turn-token-id' },
      d1Databases: { DB: 'triscord-accounts-test-ice' },
      outboundService(request) {
        upstreamCalls++;
        assert(request.url.startsWith('https://rtc.live.cloudflare.com/v1/turn/keys/fake-turn-token-id/credentials/generate-ice-servers'));
        assert.equal(request.headers.get('Authorization'), `Bearer ${fakeToken}`);
        return Response.json({ iceServers: stubIceServers });
      } }));
    try {
      const iceDb = await iceMf.getD1Database('DB');
      const schema = readFileSync(resolve('../cloudflare-auth/schema.sql'), 'utf8');
      for (const statement of schema.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await iceDb.exec(statement);
      const now = Date.now(), iceToken = '4'.repeat(64);
      await iceDb.prepare('INSERT INTO accounts(id, email, nick, nick_lower, avatar_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind('acct-ice', 'ice@example.com', 'Ice', 'ice', null, now, now).run();
      await iceDb.prepare('INSERT INTO sessions(token_hash, account_id, created_at, expires_at) VALUES (?,?,?,?)')
        .bind(await sha256Hex(iceToken), 'acct-ice', now, now + 30 * 24 * 60 * 60 * 1000).run();

      // No session at all -> 401, never reaching (or minting from) the TURN API.
      assert.equal((await iceMf.dispatchFetch('http://localhost/ice')).status, 401);
      assert.equal(upstreamCalls, 0);

      // Valid session -> the stubbed iceServers come back verbatim.
      const first = await iceMf.dispatchFetch('http://localhost/ice', { headers: { Authorization: `Bearer ${iceToken}` } });
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      assert.equal(first.headers.get('cache-control'), 'no-store');
      assert.deepEqual(firstBody.iceServers, stubIceServers);
      assert.equal(upstreamCalls, 1);

      // A second quick request reuses the cached mint - no second upstream call.
      const second = await iceMf.dispatchFetch('http://localhost/ice', { headers: { Authorization: `Bearer ${iceToken}` } });
      assert.equal(second.status, 200);
      assert.deepEqual((await second.json()).iceServers, stubIceServers);
      assert.equal(upstreamCalls, 1, 'second /ice request must reuse the cached credential set, not mint a new one');
      console.log('PASS: GET /ice requires a session, returns stubbed iceServers, and caches the mint across requests (1 upstream call for 2 requests)');
    } finally { await iceMf.dispose(); }
  }
  {
    // Upstream failure (bad token/quota): a clean error, never the raw
    // Cloudflare error body or the API token.
    const fakeToken = 'another-fake-turn-api-token-never-leaked';
    const failMf = new Miniflare(convertV4MiniflareOptions({ scriptPath: bundlePath, modules: true,
      compatibilityDate: '2026-10-12', host: '127.0.0.1', port: 0,
      durableObjects: { HUB: { className: 'TriscordHub', useSQLite: true } },
      bindings: { INVITE_CODE: invite, TURN_API_TOKEN: fakeToken, TURN_TOKEN_ID: 'fake-turn-token-id' },
      d1Databases: { DB: 'triscord-accounts-test-ice-fail' },
      outboundService() { return Response.json({ error: 'invalid token', secret_detail: fakeToken }, { status: 401 }); } }));
    try {
      const failDb = await failMf.getD1Database('DB');
      const schema = readFileSync(resolve('../cloudflare-auth/schema.sql'), 'utf8');
      for (const statement of schema.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await failDb.exec(statement);
      const now = Date.now(), failToken = '5'.repeat(64);
      await failDb.prepare('INSERT INTO accounts(id, email, nick, nick_lower, avatar_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind('acct-icefail', 'icefail@example.com', 'IceFail', 'icefail', null, now, now).run();
      await failDb.prepare('INSERT INTO sessions(token_hash, account_id, created_at, expires_at) VALUES (?,?,?,?)')
        .bind(await sha256Hex(failToken), 'acct-icefail', now, now + 30 * 24 * 60 * 60 * 1000).run();

      const res = await failMf.dispatchFetch('http://localhost/ice', { headers: { Authorization: `Bearer ${failToken}` } });
      assert.equal(res.status, 502);
      const text = await res.text();
      assert(!text.includes(fakeToken), 'upstream failure response must never leak the TURN API token');
      assert(!text.includes('invalid token'), 'upstream failure response must never leak Cloudflare\'s raw error body');
      console.log('PASS: GET /ice upstream failure -> clean 502, no token or raw Cloudflare error body leaked');
    } finally { await failMf.dispose(); }
  }
  {
    // TURN_API_TOKEN not bound (e.g. local dev without the secret) -> a
    // distinct, clean failure rather than an unhandled throw.
    const noTokenMf = new Miniflare(convertV4MiniflareOptions({ scriptPath: bundlePath, modules: true,
      compatibilityDate: '2026-10-12', host: '127.0.0.1', port: 0,
      durableObjects: { HUB: { className: 'TriscordHub', useSQLite: true } },
      bindings: {},
      d1Databases: { DB: 'triscord-accounts-test-ice-noconfig' } }));
    try {
      const noTokenDb = await noTokenMf.getD1Database('DB');
      const schema = readFileSync(resolve('../cloudflare-auth/schema.sql'), 'utf8');
      for (const statement of schema.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await noTokenDb.exec(statement);
      const now = Date.now(), noTokenToken = '6'.repeat(64);
      await noTokenDb.prepare('INSERT INTO accounts(id, email, nick, nick_lower, avatar_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind('acct-noturn', 'noturn@example.com', 'NoTurn', 'noturn', null, now, now).run();
      await noTokenDb.prepare('INSERT INTO sessions(token_hash, account_id, created_at, expires_at) VALUES (?,?,?,?)')
        .bind(await sha256Hex(noTokenToken), 'acct-noturn', now, now + 30 * 24 * 60 * 60 * 1000).run();

      const res = await noTokenMf.dispatchFetch('http://localhost/ice', { headers: { Authorization: `Bearer ${noTokenToken}` } });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'service_not_configured');
      console.log('PASS: GET /ice with no TURN_API_TOKEN bound fails cleanly with 503, not a throw');
      const serverSchema = readFileSync(resolve('migrations/0001_servers.sql'), 'utf8');
      for (const sql of serverSchema.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await noTokenDb.exec(sql);
      const createdServer = await noTokenMf.dispatchFetch('http://localhost/servers', {
        method: 'POST', headers: { Authorization: `Bearer ${noTokenToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'No legacy secret' })
      });
      assert.equal(createdServer.status, 201);
      const { id } = await createdServer.json();
      const socketResponse = await noTokenMf.dispatchFetch(`http://localhost/socket.io/?EIO=4&transport=websocket&serverId=${id}&sessionToken=${noTokenToken}`, { headers: { Upgrade: 'websocket' } });
      assert.equal(socketResponse.status, 101);
      const memberClient = new Client(socketResponse.webSocket);
      try { assert.equal(await memberClient.auth(''), true); }
      finally { memberClient.close(); }
      assert.equal((await noTokenMf.dispatchFetch('http://localhost/socket.io/?EIO=4&transport=websocket', { headers: { Upgrade: 'websocket' } })).status, 503);
      console.log('PASS: Qt nested session contract, pinned server identity, forged-header rejection, member handshake without a legacy invite or INVITE_CODE');
    } finally { await noTokenMf.dispose(); }
  }

  // Optional real C++ clients against the actual Workers runtime (no cloud).
  const native = process.env.TRISCORD_NATIVE_SCREEN_SMOKE;
  if (native) {
    const url = await mf.ready;
    const child = spawn(resolve(native), [url.origin], { env: { ...process.env, TRISCORD_TEST_INVITE: invite }, stdio: 'inherit', windowsHide: true });
    const code = await new Promise((resolve, reject) => { child.on('error',reject); child.on('exit',resolve); });
    assert.equal(code,0,'Native screen/voice clients failed against Workers runtime');
  }
} finally { for (const client of clients) client.close(); await mf.dispose(); }
