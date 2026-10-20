import { DurableObject } from 'cloudflare:workers';
import sanitize from '../../server/sanitize.js';
import soundCatalog from '../../shared/soundboard_catalog.json';
import { handleErrorReports } from './error_reports.js';
const soundIds = new Set(soundCatalog.map(sound => sound.id));

const { sanitizeUsername, sanitizeUserId, sanitizeColor, sanitizeStatus,
  sanitizeUserStateUpdate, sanitizeMessageText, sanitizeRoomName, ALLOWED_REACTIONS } = sanitize;
const MAX_CLIENTS = 16, MAX_ROOMS = 8, DAILY_EVENTS = 24000;
const json = (data, status = 200) => Response.json(data, { status });
const SESSION_TOKEN_RE = /^[0-9a-f]{64}$/;
const DEFAULT_NICK = 'Sem apelido';
// Written only by the outer Worker after session+membership validation.
// Every ingress route replaces/removes an incoming copy before forwarding.
const HUB_IDENTITY_HEADER = 'X-Triscord-Verified-Identity';
function hubRequest(request, identity = null) {
  const headers = new Headers(request.headers);
  headers.delete(HUB_IDENTITY_HEADER);
  if (identity) headers.set(HUB_IDENTITY_HEADER, JSON.stringify(identity));
  return new Request(request, { headers });
}
function bytesToHex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }
// Mirrors cloudflare-auth/src/worker.js's sha256Hex exactly: the auth Worker
// stores only sha256Hex(token) in sessions.token_hash, so the hub must derive
// the identical hash from the token the client hands it to find that row.
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}
function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 128 || b.length < 16 || b.length > 128) return false;
  let mismatch = a.length ^ b.length;
  for (let n = 0; n < 128; ++n) mismatch |= (a.charCodeAt(n) || 0) ^ (b.charCodeAt(n) || 0);
  return mismatch === 0;
}
// The one, shared way to turn a session token into an account identity. Both
// the HTTP /servers* API below and TriscordHub.resolveIdentity (used during
// the WebSocket join flow) call this - there is only ever one session
// scheme. Mirrors cloudflare-auth/src/worker.js's getSessionAccount: that
// worker stores only sha256Hex(token) in sessions.token_hash, so deriving
// the identical hash here is what finds the same row.
async function resolveSession(env, sessionToken) {
  if (typeof sessionToken !== 'string' || !SESSION_TOKEN_RE.test(sessionToken) || !env.DB) return null;
  return resolveSessionHash(env, await sha256Hex(sessionToken));
}
async function resolveSessionHash(env, hash) {
  const row = await env.DB.prepare(
    'SELECT a.id AS id, a.nick AS nick, s.expires_at AS expiresAt FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?1 AND s.expires_at > ?2'
  ).bind(hash, Date.now()).first();
  if (!row) return null;
  const nick = typeof row.nick === 'string' && row.nick.trim() ? sanitizeUsername(row.nick) : DEFAULT_NICK;
  // Only the hash is retained in hibernating socket attachments, never the bearer token.
  return { accountId: String(row.id), nick, sessionHash: hash, expiresAt: row.expiresAt };
}
function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}
// GET /ice: mints short-lived TURN/STUN credentials from Cloudflare Realtime
// so native clients behind symmetric NAT (or UDP-blocking networks) can
// relay WebRTC media. Requires a valid session - minting for anonymous
// callers would let anyone burn the account's free-tier TURN bandwidth.
//
// TTL = 600s (10 minutes): long enough to cover ICE negotiation plus a
// typical call without the credential set expiring mid-call (unlike the
// 86400s/24h example in Cloudflare's docs, which stays valid far longer than
// any single call needs), short enough that a leaked credential set is
// useless within minutes.
//
// In-isolate cache for ICE_CACHE_MS = 300s (half the TTL): reusing one
// minted set across requests for up to half its TTL guarantees any client
// handed a cached set still has >= 300s of validity left - comfortably
// enough to complete ICE negotiation - while cutting generate-ice-servers
// calls to at most one per five minutes per isolate, well clear of rate
// limits. The cache is a plain module-level variable: it is intentionally
// per-isolate (not shared across colos/instances) since it only exists to
// cut down redundant upstream calls, never to prove freshness.
const ICE_TTL_SECONDS = 600;
const ICE_CACHE_MS = (ICE_TTL_SECONDS / 2) * 1000;
let iceCache = null; // { iceServers, cachedAt }
let icePending = null;
const ICE_UPSTREAM_TIMEOUT_MS = 5000;
const iceJson = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store' }
});
async function handleIce(request, env) {
  const identity = await resolveSession(env, bearerToken(request));
  if (!identity) return iceJson({ error: 'unauthorized' }, 401);
  if (!env.TURN_API_TOKEN || !env.TURN_TOKEN_ID) return iceJson({ error: 'service_not_configured' }, 503);

  if (iceCache && Date.now() - iceCache.cachedAt < ICE_CACHE_MS) return iceJson({ iceServers: iceCache.iceServers });

  if (!icePending) icePending = mintIce(env).finally(() => { icePending = null; });
  const iceServers = await icePending;
  return iceServers ? iceJson({ iceServers }) : iceJson({ error: 'turn_unavailable' }, 502);
}
function validIceServers(servers) {
  if (!Array.isArray(servers) || !servers.length || servers.length > 16) return false;
  return servers.every(server => {
    if (!server || typeof server !== 'object') return false;
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8 || !urls.every(url =>
      typeof url === 'string' && url.length <= 2048 && /^(?:stun|stuns|turn|turns):[^\s]+$/.test(url))) return false;
    return !urls.some(url => /^turns?:/.test(url)) ||
      (typeof server.username === 'string' && server.username.length > 0 && server.username.length <= 1024 &&
       typeof server.credential === 'string' && server.credential.length > 0 && server.credential.length <= 1024);
  });
}
async function mintIce(env) {
  try {
    const upstream = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_TOKEN_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: ICE_TTL_SECONDS }),
        signal: AbortSignal.timeout(ICE_UPSTREAM_TIMEOUT_MS),
      }
    );
    if (!upstream.ok) return null;
    const body = await upstream.json();
    if (!validIceServers(body?.iceServers)) return null;
    iceCache = { iceServers: body.iceServers, cachedAt: Date.now() };
    return body.iceServers;
  } catch {
    // Timeout/network/invalid JSON: never expose tokens or provider details.
    return null;
  }
}
const SERVERS_RE = /^\/servers\/?$/;
const SERVER_DETAIL_RE = /^\/servers\/([A-Za-z0-9_-]{1,64})$/;
const SERVER_INVITES_RE = /^\/servers\/([A-Za-z0-9_-]{1,64})\/invites$/;
const SERVER_LEAVE_RE = /^\/servers\/([A-Za-z0-9_-]{1,64})\/leave$/;
const INVITE_ACCEPT_RE = /^\/invites\/([0-9a-f]{32})\/accept$/;
// The server directory, membership and invites API. Lives outside the
// WebSocket/Durable Object path entirely: servers/server_members/
// server_invites are rows in the shared D1 database (global, not per-DO
// state), so this never touches a TriscordHub instance.
async function handleServersApi(request, env, url) {
  if (!env.DB) return json({ error: 'service_not_configured' }, 503);
  const identity = await resolveSession(env, bearerToken(request));
  if (!identity) return json({ error: 'unauthorized' }, 401);
  const accountId = identity.accountId;

  if (request.method === 'POST' && SERVERS_RE.test(url.pathname)) {
    let body; try { body = await request.json(); } catch { body = {}; }
    const name = sanitizeRoomName(body && body.name);
    if (!name) return json({ error: 'invalid_name' }, 400);
    const id = crypto.randomUUID(), now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO servers(id,name,owner_account_id,created_at) VALUES (?1,?2,?3,?4)').bind(id, name, accountId, now),
      env.DB.prepare('INSERT INTO server_members(server_id,account_id,joined_at) VALUES (?1,?2,?3)').bind(id, accountId, now)
    ]);
    return json({ id, name, ownerAccountId: accountId, createdAt: now }, 201);
  }

  if (request.method === 'GET' && SERVERS_RE.test(url.pathname)) {
    const rows = await env.DB.prepare(
      'SELECT s.id AS id, s.name AS name, s.owner_account_id AS ownerAccountId, s.created_at AS createdAt FROM server_members m JOIN servers s ON s.id = m.server_id WHERE m.account_id = ?1 ORDER BY s.created_at ASC'
    ).bind(accountId).all();
    return json({ servers: rows.results || [] });
  }

  const detailMatch = url.pathname.match(SERVER_DETAIL_RE);
  if (request.method === 'GET' && detailMatch) {
    const serverId = detailMatch[1];
    // Members only: a non-member gets 403, never server metadata or a roster.
    const member = await env.DB.prepare('SELECT 1 FROM server_members WHERE server_id=?1 AND account_id=?2').bind(serverId, accountId).first();
    if (!member) return json({ error: 'forbidden' }, 403);
    const server = await env.DB.prepare('SELECT id, name, owner_account_id AS ownerAccountId, created_at AS createdAt FROM servers WHERE id=?1').bind(serverId).first();
    if (!server) return json({ error: 'not_found' }, 404);
    const members = await env.DB.prepare(
      'SELECT a.id AS accountId, a.nick AS nick, m.joined_at AS joinedAt FROM server_members m JOIN accounts a ON a.id = m.account_id WHERE m.server_id=?1 ORDER BY m.joined_at ASC'
    ).bind(serverId).all();
    return json({
      ...server,
      members: (members.results || []).map(r => ({
        accountId: r.accountId,
        nick: (typeof r.nick === 'string' && r.nick.trim()) ? sanitizeUsername(r.nick) : DEFAULT_NICK,
        joinedAt: r.joinedAt
      }))
    });
  }

  // DELETE /servers/:id - only the owner deletes a server (Discord: "Excluir servidor", owner only). Removes the
  // server, its members and invites in one batch; the socket handshake checks membership, so nobody joins it again.
  if (request.method === 'DELETE' && detailMatch) {
    const serverId = detailMatch[1];
    const server = await env.DB.prepare('SELECT owner_account_id AS ownerAccountId FROM servers WHERE id=?1').bind(serverId).first();
    if (!server) return json({ error: 'not_found' }, 404);
    if (server.ownerAccountId !== accountId) return json({ error: 'forbidden' }, 403);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM server_invites WHERE server_id=?1').bind(serverId),
      env.DB.prepare('DELETE FROM server_members WHERE server_id=?1').bind(serverId),
      env.DB.prepare('DELETE FROM servers WHERE id=?1').bind(serverId)
    ]);
    return json({ deleted: serverId });
  }

  // POST /servers/:id/leave - a member leaves ("Sair do servidor"). The owner cannot leave its own server: Discord
  // only offers it deletion.
  const leaveMatch = url.pathname.match(SERVER_LEAVE_RE);
  if (request.method === 'POST' && leaveMatch) {
    const serverId = leaveMatch[1];
    const server = await env.DB.prepare('SELECT owner_account_id AS ownerAccountId FROM servers WHERE id=?1').bind(serverId).first();
    if (!server) return json({ error: 'not_found' }, 404);
    if (server.ownerAccountId === accountId) return json({ error: 'owner_cannot_leave' }, 409);
    const result = await env.DB.prepare('DELETE FROM server_members WHERE server_id=?1 AND account_id=?2').bind(serverId, accountId).run();
    if (!result.meta || !result.meta.changes) return json({ error: 'forbidden' }, 403);
    return json({ left: serverId });
  }

  const invitesMatch = url.pathname.match(SERVER_INVITES_RE);
  if (request.method === 'POST' && invitesMatch) {
    const serverId = invitesMatch[1];
    const server = await env.DB.prepare('SELECT owner_account_id AS ownerAccountId FROM servers WHERE id=?1').bind(serverId).first();
    if (!server) return json({ error: 'not_found' }, 404);
    // Only the owner may mint invites - never trust a client-supplied account id.
    if (server.ownerAccountId !== accountId) return json({ error: 'forbidden' }, 403);
    let body; try { body = await request.json(); } catch { body = {}; }
    const maxUses = Number.isInteger(body && body.maxUses) && body.maxUses > 0 ? body.maxUses : null;
    const expiresInMs = Number.isFinite(body && body.expiresInMs) && body.expiresInMs > 0 ? body.expiresInMs : null;
    // crypto.getRandomValues, not Math.random: an invite code is a bearer
    // secret anyone holding it can redeem.
    const code = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const now = Date.now(), expiresAt = expiresInMs ? now + expiresInMs : null;
    await env.DB.batch([
      // Bound maintenance to this server and a small batch per new invite.
      env.DB.prepare('DELETE FROM server_invites WHERE code IN (SELECT code FROM server_invites WHERE server_id=? AND expires_at IS NOT NULL AND expires_at<=? LIMIT 100)')
        .bind(serverId, now),
      env.DB.prepare('INSERT INTO server_invites(code,server_id,created_by,created_at,expires_at,max_uses,uses) VALUES (?1,?2,?3,?4,?5,?6,0)')
        .bind(code, serverId, accountId, now, expiresAt, maxUses)
    ]);
    return json({ code, serverId, expiresAt, maxUses }, 201);
  }

  const acceptMatch = url.pathname.match(INVITE_ACCEPT_RE);
  if (request.method === 'POST' && acceptMatch) {
    const code = acceptMatch[1], now = Date.now();
    // One transaction claims quota AND creates membership. changes() binds
    // the INSERT to this transaction's successful UPDATE. A repeat accept
    // by a member consumes no quota, even when that invite is now exhausted.
    // Expired/unknown invites still fail for everyone.
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE server_invites SET uses=uses+1 WHERE code=?1
        AND (expires_at IS NULL OR expires_at>?2) AND (max_uses IS NULL OR uses<max_uses)
        AND NOT EXISTS(SELECT 1 FROM server_members WHERE server_id=server_invites.server_id AND account_id=?3)`)
        .bind(code, now, accountId),
      env.DB.prepare(`INSERT OR IGNORE INTO server_members(server_id,account_id,joined_at)
        SELECT server_id,?2,?3 FROM server_invites WHERE code=?1 AND changes()>0`)
        .bind(code, accountId, now),
      env.DB.prepare(`SELECT i.server_id AS serverId FROM server_invites i JOIN server_members m
        ON m.server_id=i.server_id AND m.account_id=?2 WHERE i.code=?1 AND (i.expires_at IS NULL OR i.expires_at>?3)`)
        .bind(code, accountId, now)
    ]);
    const invite = result[2].results[0];
    return invite ? json({ serverId: invite.serverId }) : json({ error: 'invite_invalid' }, 410);
  }

  return json({ error: 'not_found' }, 404);
}
export default {
  async fetch(request, env) {
    try { return await handleRequest(request, env); }
    catch { return json({ error: 'service_unavailable' }, 503); }
  }
};
async function handleRequest(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health'))
      return json({ ok: true, service: 'triscord-native-control', version: '0.6.0' });
    if (request.method === 'GET' && url.pathname === '/ice') return handleIce(request, env);
    const reports = await handleErrorReports(request, env, url, { json, resolveSession, bearerToken, equalSecret });
    if (reports) return reports;
    if (SERVERS_RE.test(url.pathname) || SERVER_DETAIL_RE.test(url.pathname) || SERVER_INVITES_RE.test(url.pathname) || SERVER_LEAVE_RE.test(url.pathname) || INVITE_ACCEPT_RE.test(url.pathname))
      return handleServersApi(request, env, url);
    if (url.pathname !== '/socket.io/' || url.searchParams.get('EIO') !== '4' || url.searchParams.get('transport') !== 'websocket') return json({ error: 'not_found' }, 404);
    // WebSocket routing contract: an optional ?serverId=<id> query parameter
    // on the socket.io handshake URL selects which per-server Durable Object
    // instance to connect to (getByName(serverId) - one DO instance per
    // server). A connection with no serverId at all (legacy/older clients,
    // and today's web client until it is updated) maps to the original
    // 'private-group-v1' instance, unchanged, so existing rooms/history are
    // never orphaned. When serverId IS present, the connecting account must
    // already be a member of that server - proven via ?sessionToken=<hex> on
    // the same handshake URL (a WebSocket upgrade from a browser/native
    // client cannot set an Authorization header, hence the query parameter)
    // resolved through the exact same resolveSession/session-token scheme as
    // everything else. A non-member, or a request with no/invalid
    // sessionToken, never reaches the Durable Object.
    const serverId = url.searchParams.get('serverId');
    if (serverId) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverId)) return json({ error: 'invalid_server' }, 400);
      if (!env.DB) return json({ error: 'service_not_configured' }, 503);
      const identity = await resolveSession(env, url.searchParams.get('sessionToken'));
      if (!identity) return json({ error: 'unauthorized' }, 401);
      const member = await env.DB.prepare('SELECT 1 FROM server_members WHERE server_id=?1 AND account_id=?2').bind(serverId, identity.accountId).first();
      if (!member) return json({ error: 'forbidden' }, 403);
      return env.HUB.getByName(serverId).fetch(hubRequest(request, { ...identity, serverId }));
    }
    if (!env.INVITE_CODE || env.INVITE_CODE.length < 16) return json({ error: 'service_not_configured' }, 503);
    return env.HUB.getByName('private-group-v1').fetch(hubRequest(request));
}
export class TriscordHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.ctx = ctx; this.env = env;
    this.clients = new Map(); this.rooms = new Map();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('3', '6'));
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, room TEXT NOT NULL, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS messages_room ON messages(room)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY, events INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS maintenance(id TEXT PRIMARY KEY)');
    if (!ctx.storage.sql.exec('SELECT id FROM maintenance WHERE id=?', 'remove-native-validation-v1').toArray().length) {
      // Remove only the legacy acceptance fixture explicitly requested by the user.
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec('DELETE FROM messages WHERE room=?', 'native-validation');
        ctx.storage.sql.exec('DELETE FROM rooms WHERE id=?', 'native-validation');
        ctx.storage.sql.exec('INSERT INTO maintenance(id) VALUES(?)', 'remove-native-validation-v1');
      });
    }
    for (const row of ctx.storage.sql.exec('SELECT id,data FROM rooms')) this.rooms.set(row.id, JSON.parse(row.data));
    if (!this.rooms.size) for (const [id, name] of [['geral', 'Geral'], ['jogos', 'Jogos']]) {
      this.rooms.set(id, { id, name, ownerUserId: null, locked: false, maxUsers: 10 }); this.saveRoom(id);
    }
    for (const ws of ctx.getWebSockets()) {
      const data = ws.deserializeAttachment(); if (!data) continue;
      const client = { ws, data }; this.clients.set(data.sid, client);
      if (data.room && !this.rooms.has(data.room)) {
        const removed = data.room; data.room = null; data.user = null; this.attach(client);
        this.send(client, 'kicked', { roomId: removed });
      }
    }
    this.broadcast('rooms-update', this.directory());
  }
  send(client, name, payload) { try { client.ws.send('42' + JSON.stringify([name, payload])); } catch { } }
  broadcast(name, payload, room = null, except = null) {
    for (const client of this.clients.values()) if (client.data.ready && client.data.sid !== except && (!room || client.data.room === room)) this.send(client, name, payload);
  }
  saveRoom(id) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO rooms(id,data) VALUES(?,?)', id, JSON.stringify(this.rooms.get(id))); }
  attach(client) { client.ws.serializeAttachment(client.data); }
  users(room) { return [...this.clients.values()].filter(c => c.data.ready && c.data.room === room && c.data.user); }
  directory() { return [...this.rooms.values()].map(room => ({ ...room, userCount: this.users(room.id).length, users: this.users(room.id).map(c => c.data.user) })); }
  history(room) { return [...this.ctx.storage.sql.exec('SELECT data FROM (SELECT rowid,data FROM messages WHERE room=? ORDER BY rowid DESC LIMIT 200) ORDER BY rowid', room)].map(row => JSON.parse(row.data)); }
  owner(client, room) { return room && client.data.user && room.ownerUserId === client.data.user.userId; }
  consumeBudget(client) {
    const day = new Date().toISOString().slice(0, 10);
    this.ctx.storage.sql.exec('DELETE FROM budget WHERE day<>?', day);
    const current = this.ctx.storage.sql.exec('SELECT events FROM budget WHERE day=?', day).toArray()[0]?.events || 0;
    if (current >= DAILY_EVENTS) {
      if (client.data.limitedDay !== day) { client.data.limitedDay = day; this.attach(client); this.send(client, 'service-limit', { message: 'O limite gratuito diário foi atingido. O serviço retoma no próximo dia UTC.' }); }
      return false;
    }
    this.ctx.storage.sql.exec('INSERT INTO budget(day,events) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET events=events+1', day); return true;
  }
  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
    if (this.clients.size >= MAX_CLIENTS) return json({ error: 'group_full' }, 429);
    const pair = new WebSocketPair(), [clientSocket, serverSocket] = Object.values(pair);
    const identity = JSON.parse(request.headers.get(HUB_IDENTITY_HEADER) || 'null');
    const data = { sid: crypto.randomUUID(), identity, ready: false, room: null, user: null, created: Date.now(), rateTime: 0, rateCount: 0 };
    this.ctx.acceptWebSocket(serverSocket); const client = { ws: serverSocket, data }; this.clients.set(data.sid, client); this.attach(client);
    serverSocket.send('0' + JSON.stringify({ sid: data.sid, upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 262144 }));
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 25000);
    return new Response(null, { status: 101, webSocket: clientSocket });
  }
  async webSocketMessage(ws, message) {
    const attached = ws.deserializeAttachment(), client = attached && this.clients.get(attached.sid);
    if (!client) return;
    if (typeof message !== 'string' || message.length > 262144) { ws.close(1009, 'Control message too large'); this.close(client); return; }
    const now = Date.now();
    if (now - client.data.rateTime > 1000) { client.data.rateTime = now; client.data.rateCount = 0; }
    if (++client.data.rateCount > 40) { ws.close(1008, 'Control rate limit'); this.close(client); return; }
    if (!(await this.validateSession(client))) return;
    this.attach(client);
    try {
      if (message.startsWith('40') && !client.data.ready) {
        const auth = message.length > 2 ? JSON.parse(message.slice(2)) : {};
        if (!client.data.identity && !equalSecret(auth.invite, this.env.INVITE_CODE)) { ws.send('44' + JSON.stringify({ message: 'Código do grupo inválido' })); ws.close(1008, 'Unauthorized'); this.close(client); return; }
        if (!this.consumeBudget(client)) { ws.close(1008, 'Daily limit'); this.close(client); return; }
        client.data.ready = true; this.attach(client);
        ws.send('40' + JSON.stringify({ sid: client.data.sid }));
        this.send(client, 'ice-servers', [{ urls: 'stun:stun.cloudflare.com:3478' }]);
        this.send(client, 'rooms-update', this.directory()); return;
      }
      if (message === '41' || message === '1') { this.close(client); ws.close(1000, 'Left'); return; }
      if (message === '3' || message === '6') return;
      if (!client.data.ready || !message.startsWith('42[') || !this.consumeBudget(client)) return;
      const args = JSON.parse(message.slice(2));
      if (!Array.isArray(args) || args.length !== 2 || typeof args[0] !== 'string' || !args[1] || typeof args[1] !== 'object' || Array.isArray(args[1])) return;
      await this.event(client, args[0], args[1]);
    } catch { this.send(client, 'request-error', { message: 'Não foi possível processar esta solicitação.' }); }
  }
  async event(client, name, payload) {
    const room = this.rooms.get(client.data.room);
    if (name === 'join-room') return this.join(client, payload);
    if (name === 'leave-room') return this.leave(client);
    if (!room || !client.data.user) return;
    if (['webrtc-offer','webrtc-answer','webrtc-ice-candidate'].includes(name)) {
      const target = this.clients.get(payload.targetSocketId);
      if (!target || target === client || target.data.room !== client.data.room || !['voice','native-screen','native-camera'].includes(payload.type)) return;
      const signal = { senderSocketId: client.data.sid, type: payload.type, session: payload.session, targetSession: payload.targetSession };
      if (name === 'webrtc-ice-candidate') signal.candidate = payload.candidate;
      else signal[name === 'webrtc-offer' ? 'offer' : 'answer'] = payload[name === 'webrtc-offer' ? 'offer' : 'answer'];
      this.send(target, name, signal); return;
    }
    if (name === 'user-state-change') {
      const clean = sanitizeUserStateUpdate(payload); delete clean.pcHealth;
      if (client.data.user.isServerMuted) {
        if (clean.isMuted === false) this.send(client, 'force-muted', { muted: true });
        clean.isMuted = true; clean.isSpeaking = false;
      }
      Object.assign(client.data.user, clean); this.attach(client);
      this.broadcast('user-state-updated', { socketId: client.data.sid, state: clean }, room.id);
      this.broadcast('rooms-update', this.directory()); return;
    }
    if (name === 'send-chat-message') {
      if (payload.roomId && payload.roomId !== room.id) return;
      const text = sanitizeMessageText(payload.message); if (!text) return;
      if (Date.now() - (client.data.lastChat || 0) < 500) { this.send(client, 'chat-rate-limited', {}); return; }
      client.data.lastChat = Date.now(); this.attach(client);
      const message = { id: crypto.randomUUID(), roomId: room.id, senderSocketId: client.data.sid, senderUserId: client.data.user.userId,
        senderName: client.data.user.username, senderAvatar: client.data.user.avatar, text, reactions: {}, timestamp: Date.now() };
      this.ctx.storage.sql.exec('INSERT INTO messages(id,room,data) VALUES(?,?,?)', message.id, room.id, JSON.stringify(message));
      this.ctx.storage.sql.exec('DELETE FROM messages WHERE room=? AND id NOT IN (SELECT id FROM messages WHERE room=? ORDER BY rowid DESC LIMIT 200)', room.id, room.id);
      this.broadcast('new-chat-message', message, room.id); return;
    }
    if (name === 'add-reaction') {
      if (!ALLOWED_REACTIONS.includes(payload.emoji)) return;
      const row = this.ctx.storage.sql.exec('SELECT data FROM messages WHERE id=? AND room=?', payload.messageId, room.id).toArray()[0]; if (!row) return;
      const message = JSON.parse(row.data), ids = message.reactions[payload.emoji] || [];
      message.reactions[payload.emoji] = ids.includes(client.data.user.userId) ? ids.filter(id => id !== client.data.user.userId) : [...ids.slice(0, 9), client.data.user.userId];
      if (!message.reactions[payload.emoji].length) delete message.reactions[payload.emoji];
      this.ctx.storage.sql.exec('UPDATE messages SET data=? WHERE id=?', JSON.stringify(message), message.id);
      this.broadcast('message-reaction-updated', { roomId: room.id, messageId: message.id, reactions: message.reactions }, room.id); return;
    }
    if (name === 'delete-chat-message') {
      if (typeof payload.messageId !== 'string' || payload.messageId.length > 64 || (payload.roomId && payload.roomId !== room.id)) return;
      const row = this.ctx.storage.sql.exec('SELECT data FROM messages WHERE id=? AND room=?', payload.messageId, room.id).toArray()[0];
      if (!row) return;
      const message = JSON.parse(row.data);
      if (message.senderUserId !== client.data.user.userId) { this.send(client, 'request-error', { message: 'você só pode excluir as próprias mensagens' }); return; }
      this.ctx.storage.sql.exec('DELETE FROM messages WHERE id=? AND room=?', message.id, room.id);
      this.broadcast('chat-message-deleted', { roomId: room.id, messageId: message.id }, room.id); return;
    }
    if (name === 'soundboard-play') {
      if (!soundIds.has(payload.soundId)) return;
      if (Date.now() - (client.data.lastSound || 0) < 1000) {
        this.send(client, 'request-error', { message: 'aguarde antes de tocar outro som' }); return;
      }
      client.data.lastSound = Date.now(); this.attach(client);
      this.broadcast('soundboard-played', { soundId: payload.soundId, roomId: room.id, bySocketId: client.data.sid }, room.id); return;
    }
    if (name === 'screen-watch' || name === 'camera-watch') {
      const target = this.clients.get(payload.targetSocketId); if (target && target.data.room === room.id && target !== client)
        this.send(target, name, { senderSocketId: client.data.sid, watching: payload.watching !== false }); return;
    }
    if (!this.owner(client, room)) return;
    if (name === 'update-room-settings') {
      if (typeof payload.locked === 'boolean') room.locked = payload.locked;
      if (Number.isInteger(payload.maxUsers) && payload.maxUsers >= 1 && payload.maxUsers <= 10) room.maxUsers = payload.maxUsers;
      this.saveRoom(room.id); this.broadcast('rooms-update', this.directory()); return;
    }
    const target = this.clients.get(payload.socketId); if (!target || target.data.room !== room.id) return;
    if (name === 'kick-user' && target !== client) { this.send(target, 'kicked', { roomId: room.id }); this.leave(target); }
    else if (name === 'force-mute-user') {
      const muted = payload.muted !== false;
      const ids = room.serverMutedUserIds || [];
      if (muted && !ids.includes(target.data.user.userId) && ids.length >= 200) { this.send(client, 'request-error', { message: 'limite de controles da sala atingido' }); return; }
      room.serverMutedUserIds = muted ? [...new Set([...ids, target.data.user.userId])] : ids.filter(id => id !== target.data.user.userId);
      this.saveRoom(room.id);
      target.data.user.isServerMuted = muted; target.data.user.isMuted = true; this.attach(target);
      this.send(target, 'force-muted', { muted });
      this.broadcast('user-state-updated', { socketId: target.data.sid, state: { isMuted: true, isServerMuted: muted } }, room.id); this.broadcast('rooms-update', this.directory());
    }
  }
  // The session token (sha256Hex of it, really) is the only way identity can
  // be established server-side; cloudflare-auth/src/worker.js writes the same
  // hash into sessions.token_hash, so a match here proves the same signed-in
  // account, independent of anything else the client claims about itself.
  async resolveIdentity(sessionToken) {
    return resolveSession(this.env, sessionToken);
  }
  async validateSession(client) {
    const identity = client.data.identity;
    if (!identity) return true; // Legacy invite-only guests have no account session.
    let current;
    try {
      current = identity.sessionHash && await resolveSessionHash(this.env, identity.sessionHash);
      if (current && current.accountId === identity.accountId && identity.serverId) {
        const member = await this.env.DB.prepare('SELECT 1 FROM server_members WHERE server_id=? AND account_id=?')
          .bind(identity.serverId, identity.accountId).first();
        if (!member) current = null;
      }
    } catch {
      client.ws.close(1013, 'Service temporarily unavailable'); this.close(client); return false;
    }
    if (this.clients.get(client.data.sid) !== client) return false;
    if (!current || current.accountId !== identity.accountId) {
      client.ws.close(1008, 'Session expired or revoked'); this.close(client); return false;
    }
    return true;
  }
  // Prevents an unauthenticated guest from picking a display name that matches
  // a registered account's nick, which would otherwise let anyone impersonate
  // a real identity simply by not sending a session.
  async nickIsRegistered(nickLower) {
    if (!nickLower || !this.env.DB) return false;
    return !!(await this.env.DB.prepare('SELECT 1 FROM accounts WHERE nick_lower = ?1 LIMIT 1').bind(nickLower).first());
  }
  async join(client, payload) {
    const id = payload.roomId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
    let room = this.rooms.get(id);
    if (!room) {
      if (this.rooms.size >= MAX_ROOMS) { this.send(client, 'room-join-denied', {}); return; }
      room = { id, name: sanitizeRoomName(payload.roomName) || id, ownerUserId: null, locked: false, maxUsers: 10 };
      this.rooms.set(id, room); this.saveRoom(id);
    }
    const source = payload.userData || {};
    // A valid session is authoritative: the database nick wins, period, and
    // anything the client sent for its own name/userId in this same payload
    // is discarded. Without a valid session the connection is kept alive as a
    // clearly-marked, unauthenticated guest (older native clients that don't
    // send sessionToken yet still work) but it may not claim a name that
    // belongs to a real account.
    // Per-server connections are pinned to the identity checked at ingress;
    // clients cannot switch/downgrade that identity inside a room payload.
    // Legacy clients send the token either at the root or in userData (Qt).
    const identity = client.data.identity || await this.resolveIdentity(payload.sessionToken || payload.userData?.sessionToken);
    let userId, username, authenticated;
    if (identity) {
      client.data.identity = identity;
      userId = identity.accountId; username = identity.nick; authenticated = true;
    } else {
      authenticated = false;
      userId = sanitizeUserId(source.userId) || client.data.sid;
      username = sanitizeUsername(source.username);
      if (await this.nickIsRegistered(username.trim().toLowerCase())) username = 'Convidado';
    }
    const users = this.users(id).filter(c => c !== client);
    // A claimed profile id cannot replace another connection or inherit its role.
    if (users.some(c => c.data.user.userId === userId) || users.length >= room.maxUsers ||
        (room.locked && !(client.data.room === id && this.owner(client, room)))) {
      this.send(client, 'room-join-denied', {}); return;
    }
    this.leave(client);
    client.data.room = id;
    client.data.user = { socketId: client.data.sid, userId, username, avatar: sanitizeColor(source.avatar),
      isServerMuted: (room.serverMutedUserIds || []).includes(userId), authenticated,
      status: sanitizeStatus(source.status), isMuted: true, isDeafened: false, isScreenSharing: false, isCameraOn: false, isSpeaking: false };
    if (!room.ownerUserId) { room.ownerUserId = userId; this.saveRoom(id); }
    this.attach(client);
    this.send(client, 'room-joined', { roomId: id, existingUsers: users.map(c => c.data.user), chatHistory: this.history(id),
      isServerMuted: client.data.user.isServerMuted,
      ownerUserId: room.ownerUserId, isOwner: this.owner(client, room), locked: room.locked, maxUsers: room.maxUsers });
    this.broadcast('user-joined', { socketId: client.data.sid, userData: client.data.user }, id, client.data.sid);
    this.broadcast('rooms-update', this.directory());
  }
  leave(client) {
    const id = client.data.room, user = client.data.user; if (!id) return;
    client.data.room = null; client.data.user = null; this.attach(client);
    const room = this.rooms.get(id);
    if (room && id === 'native-validation' && !this.users(id).length) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM messages WHERE room=?', id);
        this.ctx.storage.sql.exec('DELETE FROM rooms WHERE id=?', id);
      });
      this.rooms.delete(id);
    }
    else if (room && room.ownerUserId === user?.userId) {
      room.ownerUserId = this.users(id)[0]?.data.user.userId || null;
      if (!room.ownerUserId) room.locked = false;
      this.saveRoom(id);
    }
    this.broadcast('user-left', { socketId: client.data.sid, username: user?.username }, id);
    this.broadcast('rooms-update', this.directory());
  }
  close(client) { this.leave(client); this.clients.delete(client.data.sid); }
  webSocketClose(ws) { const data = ws.deserializeAttachment(); const client = data && this.clients.get(data.sid); if (client) this.close(client); }
  webSocketError(ws) { this.webSocketClose(ws); }
  async alarm() {
    const now = Date.now();
    for (const client of [...this.clients.values()]) {
      if (!(await this.validateSession(client))) continue;
      const last = this.ctx.getWebSocketAutoResponseTimestamp(client.ws)?.getTime() || client.data.created;
      if ((!client.data.ready && now - client.data.created > 10000) || now - last > 50000) { client.ws.close(1001, 'Heartbeat timeout'); this.close(client); }
      else { try { client.ws.send('2'); } catch { this.close(client); } }
    }
    if (this.clients.size) await this.ctx.storage.setAlarm(now + 25000);
  }
}
