import sanitize from '../../shared/sanitize.cjs';
import { uploadMedia, deleteMedia, serveMedia } from './profile-media.js';

const { sanitizeUsername } = sanitize;

const json = (data, status = 200) => Response.json(data, { status });

// --- Profile field validation --------------------------------------------
// Everything here is server-side-only: a client's PATCH /profile body must
// pass every one of these checks before it ever reaches D1. Unknown keys are
// rejected outright rather than silently ignored, so a client can't smuggle
// in data the API doesn't know about and have it stored anyway.

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DISPLAY_NAME_STYLE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_DISPLAY_NAME_LENGTH = 32;
const MAX_PRONOUNS_LENGTH = 40;
const MAX_BIO_LENGTH = 190; // Triscord policy; Discord's runtime limit is unverified.
const MAX_NOTE_LENGTH = 256;
const MAX_NAMEPLATE_LENGTH = 128;
const MAX_AVATAR_DECORATION_URL_LENGTH = 512;

function stripControlChars(str) {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

function validateText(value, maxLength) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const cleaned = stripControlChars(value).trim();
  if (cleaned.length > maxLength) return { ok: false };
  return { ok: true, value: cleaned || null };
}

function validateHexColor(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) return { ok: false };
  return { ok: true, value };
}

function validateUrlish(value, maxLength) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const cleaned = stripControlChars(value).trim();
  if (!cleaned || cleaned.length > maxLength) return { ok: false };
  if (!/^https:\/\//.test(cleaned)) return { ok: false };
  return { ok: true, value: cleaned };
}

function validateDisplayNameStyle(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || !DISPLAY_NAME_STYLE_RE.test(value)) return { ok: false };
  return { ok: true, value };
}

// Every editable profile field: how to validate it, and whether it is
// private (only ever returned to the account's own session, never via
// GET /profile/:id or embedded in another account's data).
const PROFILE_FIELDS = {
  display_name: { validate: v => validateText(v, MAX_DISPLAY_NAME_LENGTH), private: false },
  pronouns: { validate: v => validateText(v, MAX_PRONOUNS_LENGTH), private: false },
  bio: { validate: v => validateText(v, MAX_BIO_LENGTH), private: false },
  note: { validate: v => validateText(v, MAX_NOTE_LENGTH), private: true },
  banner_color: { validate: validateHexColor, private: false },
  nameplate: { validate: v => validateText(v, MAX_NAMEPLATE_LENGTH), private: false },
  avatar_decoration_url: { validate: v => validateUrlish(v, MAX_AVATAR_DECORATION_URL_LENGTH), private: false },
  display_name_style: { validate: validateDisplayNameStyle, private: false },
  profile_theme_start: { validate: validateHexColor, private: false },
  profile_theme_end: { validate: validateHexColor, private: false }
};

const PUBLIC_PROFILE_FIELDS = Object.keys(PROFILE_FIELDS).filter(key => !PROFILE_FIELDS[key].private);

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLOCK_SKEW_MS = 5 * 60 * 1000; // allowance for `iat` being slightly in the future
const JWKS_REFRESH_MIN_INTERVAL_MS = 60 * 1000; // throttle for forced JWKS refetches

// In-memory JWKS cache, keyed by URL. Lives only for the lifetime of this
// isolate; a cold start (or a worker restart) just refetches. Workers.dev /
// production isolates are typically reused across many requests, so this
// still saves the vast majority of lookups without needing the Cache API.
const jwksCache = new Map();
// Last forced JWKS refetch per URL. Without this, a caller sending tokens with
// random `kid` values would force an outbound request to Google on every attempt.
const jwksRefreshedAt = new Map();

function base64UrlToBytes(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

async function fetchJwks(url) {
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(url);
  if (!response.ok) throw new AuthError('jwks_unavailable');
  const body = await response.json();
  let maxAgeSeconds = 3600;
  const cacheControl = response.headers.get('cache-control') || '';
  const match = cacheControl.match(/max-age=(\d+)/);
  if (match) maxAgeSeconds = parseInt(match[1], 10);
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(url, { keys, expiresAt: Date.now() + maxAgeSeconds * 1000 });
  return keys;
}

// Looks up `kid` in the cached JWKS; on a miss, refetches once (a key
// rotation on Google's side means our cache is just stale) before giving up.
async function findKey(url, kid, { forceRefresh = false } = {}) {
  if (forceRefresh) {
    // Throttle: a genuine key rotation is rare, so at most one forced refetch
    // per window. Unknown `kid`s beyond that fail without touching the network.
    const last = jwksRefreshedAt.get(url) || 0;
    if (Date.now() - last < JWKS_REFRESH_MIN_INTERVAL_MS) return null;
    jwksRefreshedAt.set(url, Date.now());
    jwksCache.delete(url);
  }
  const keys = await fetchJwks(url);
  const key = keys.find(k => k.kid === kid);
  if (!key && !forceRefresh) return findKey(url, kid, { forceRefresh: true });
  return key || null;
}

class AuthError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Verifies a Google-issued OIDC id_token end to end: signature against
// Google's published JWKS, then every claim that matters. Nothing in
// `payload` may be trusted by the caller until this returns normally.
async function verifyGoogleIdToken(idToken, env) {
  if (typeof idToken !== 'string' || !idToken) throw new AuthError('invalid_token_format');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new AuthError('invalid_token_format');
  const [headerSeg, payloadSeg, sigSeg] = parts;

  let header, payload;
  try {
    header = base64UrlDecodeJson(headerSeg);
    payload = base64UrlDecodeJson(payloadSeg);
  } catch {
    throw new AuthError('invalid_token_format');
  }
  if (header.alg !== 'RS256') throw new AuthError('unsupported_alg');

  const jwksUrl = env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
  const jwk = await findKey(jwksUrl, header.kid);
  if (!jwk) throw new AuthError('unknown_kid');

  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
  } catch {
    throw new AuthError('invalid_key');
  }

  const signature = base64UrlToBytes(sigSeg);
  const signedData = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const signatureValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, signedData);
  if (!signatureValid) throw new AuthError('bad_signature');

  // Only after the signature checks out do we trust any claim below.
  const now = Date.now();
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new AuthError('bad_issuer');
  }
  if (!env.GOOGLE_CLIENT_ID || payload.aud !== env.GOOGLE_CLIENT_ID) throw new AuthError('bad_audience');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) throw new AuthError('expired_token');
  if (typeof payload.iat !== 'number' || payload.iat * 1000 > now + CLOCK_SKEW_MS) throw new AuthError('bad_iat');
  if (payload.email_verified !== true) throw new AuthError('email_not_verified');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new AuthError('missing_sub');
  if (typeof payload.email !== 'string' || !payload.email) throw new AuthError('missing_email');

  return payload;
}

// --- Nick sign-in (no Google account) -------------------------------------
// An account can be created with only a nick; the password comes later (POST /password). Without a password
// the account is reachable only through its existing sessions, so its nick cannot be signed into elsewhere.
const NICK_MIN_LENGTH = 2;
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 128;
const PBKDF2_ITERATIONS = 100000;   // the Workers runtime's PBKDF2 ceiling
const MAX_FAILED_LOGINS = 10;
const LOCK_MS = 15 * 60 * 1000;

function cleanNick(value) {
  if (typeof value !== 'string') return null;
  const nick = stripControlChars(value).trim();
  return nick.length >= NICK_MIN_LENGTH && nick.length <= 32 ? nick : null;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
}

async function pbkdf2Hex(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS)}`;
}

async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, expected] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2-sha256' || !salt || !expected) return false;
  const actual = await pbkdf2Hex(password, hexToBytes(salt), Number(iterations));
  // Constant-time comparison of equal-length hex digests.
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function randomSessionToken() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function createSession(env, accountId) {
  const token = randomSessionToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO sessions(token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(tokenHash, accountId, now, expiresAt).run();
  return { token, expiresAt };
}

// Session lookup is by the hash's primary-key index (an exact SQLite lookup),
// never a JS string comparison of secrets, so there is no timing side
// channel to close here the way `equalSecret` closes one in the control
// worker for a short, low-entropy invite code.
async function getSessionAccount(env, token) {
  if (typeof token !== 'string' || !token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    'SELECT account_id, expires_at FROM sessions WHERE token_hash = ?'
  ).bind(tokenHash).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  return env.DB.prepare(
    'SELECT * FROM accounts WHERE id = ?'
  ).bind(row.account_id).first();
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

// Full account view: only ever returned to the account's own authenticated
// session (/auth/google, /me, /nick) — includes email and every profile
// field, private ones included.
function serializeAccount(account) {
  const out = {
    id: account.id,
    email: account.email,
    nick: account.nick || null,
    avatar_url: account.avatar_url || null,
    banner_url: account.banner_url || null,
    is_new: !account.nick,
    created_at: account.created_at || null,
    has_password: !!account.password_hash,
    google: !String(account.id).startsWith('n_')
  };
  for (const key of Object.keys(PROFILE_FIELDS)) {
    out[key] = account[key] != null ? account[key] : null;
  }
  return out;
}

// Public profile view: safe to hand to anyone, including anonymous callers.
// Never includes email or anything session-related, and never includes a
// field marked `private` in PROFILE_FIELDS (e.g. `note`).
function serializePublicProfile(account) {
  const out = {
    id: account.id,
    nick: account.nick || null,
    avatar_url: account.avatar_url || null,
    banner_url: account.banner_url || null,
    created_at: account.created_at || null
  };
  for (const key of PUBLIC_PROFILE_FIELDS) {
    out[key] = account[key] != null ? account[key] : null;
  }
  return out;
}

async function requireSession(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  return getSessionAccount(env, token);
}

export default {
  async fetch(request, env) {
    try { return await handleRequest(request, env); }
    catch { return json({ error: 'service_unavailable' }, 503); }
  }
};
async function handleRequest(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ ok: true, service: 'triscord-auth', version: '0.1.0' });
    }

    const mediaMatch = url.pathname.match(/^\/media\/([^/]+)\/(avatar|banner)\/([0-9a-f]{64})$/);
    if (mediaMatch && ['GET', 'HEAD'].includes(request.method)) return serveMedia(request, env, mediaMatch);
    const uploadMatch = url.pathname.match(/^\/profile\/(avatar|banner)$/);
    if (uploadMatch && ['PUT', 'DELETE'].includes(request.method)) {
      const account = await requireSession(request, env);
      if (!account) return json({ error: 'unauthorized' }, 401);
      if (request.method === 'DELETE') {
        return json({ account: serializeAccount(await deleteMedia(env, account, uploadMatch[1])) });
      }
      const result = await uploadMedia(request, env, account, uploadMatch[1]);
      if (result instanceof Response) return result;
      return json({ media: result.media, account: serializeAccount(result.account) });
    }

    if (request.method === 'POST' && url.pathname === '/auth/google') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }

      let payload;
      try {
        payload = await verifyGoogleIdToken(body && body.id_token, env);
      } catch (err) {
        const code = err instanceof AuthError ? err.code : 'verification_failed';
        return json({ error: code }, 401);
      }

      const now = Date.now();
      const existing = await env.DB.prepare(
        'SELECT * FROM accounts WHERE id = ?'
      ).bind(payload.sub).first();

      let account;
      if (existing) {
        const avatarUrl = existing.avatar_custom ? existing.avatar_url : (payload.picture || existing.avatar_url || null);
        await env.DB.prepare(
          'UPDATE accounts SET email = ?, avatar_url = ?, updated_at = ? WHERE id = ?'
        ).bind(payload.email, avatarUrl, now, payload.sub).run();
        account = { ...existing, email: payload.email, avatar_url: avatarUrl };
      } else {
        await env.DB.prepare(
          'INSERT INTO accounts(id, email, nick, nick_lower, avatar_url, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)'
        ).bind(payload.sub, payload.email, payload.picture || null, now, now).run();
        account = { id: payload.sub, email: payload.email, nick: null, avatar_url: payload.picture || null };
      }

      const session = await createSession(env, payload.sub);
      return json({ session: session.token, expires_at: session.expiresAt, account: serializeAccount(account) });
    }

    // Nick sign-in. A free nick creates an account (with the password, when one is given); a taken nick signs
    // in only with that account's password. 409 nick_taken also covers a taken nick that has no password.
    if (request.method === 'POST' && url.pathname === '/auth/nick') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
      const nick = cleanNick(body && body.nick);
      if (!nick) return json({ error: 'invalid_nick' }, 400);
      const password = body.password == null || body.password === '' ? null : body.password;
      if (password !== null && !validPassword(password)) return json({ error: 'invalid_password' }, 400);
      const now = Date.now();
      const existing = await env.DB.prepare('SELECT * FROM accounts WHERE nick_lower = ?').bind(nick.toLowerCase()).first();
      if (existing) {
        if (!existing.password_hash || password === null) return json({ error: existing.password_hash ? 'password_required' : 'nick_taken' }, existing.password_hash ? 401 : 409);
        if (existing.locked_until && existing.locked_until > now) return json({ error: 'too_many_attempts', retry_at: existing.locked_until }, 429);
        if (!(await verifyPassword(password, existing.password_hash))) {
          const failed = (existing.failed_logins || 0) + 1;
          const lockedUntil = failed >= MAX_FAILED_LOGINS ? now + LOCK_MS : null;
          await env.DB.prepare('UPDATE accounts SET failed_logins = ?, locked_until = ? WHERE id = ?')
            .bind(lockedUntil ? 0 : failed, lockedUntil, existing.id).run();
          return json({ error: 'invalid_credentials' }, 401);
        }
        await env.DB.prepare('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(existing.id).run();
        const session = await createSession(env, existing.id);
        return json({ session: session.token, expires_at: session.expiresAt, account: serializeAccount(existing) });
      }
      const id = 'n_' + bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
      const passwordHash = password === null ? null : await hashPassword(password);
      try {
        await env.DB.prepare(
          'INSERT INTO accounts(id, email, nick, nick_lower, avatar_url, created_at, updated_at, password_hash) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)'
        ).bind(id, '', nick, nick.toLowerCase(), now, now, passwordHash).run();
      } catch (error) {
        if (/UNIQUE constraint failed: accounts\.nick_lower\b/.test(String(error?.message))) return json({ error: 'nick_taken' }, 409);
        throw error;
      }
      const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
      const session = await createSession(env, id);
      return json({ session: session.token, expires_at: session.expiresAt, account: serializeAccount(account), created: true }, 201);
    }

    // Sets the password of the signed-in account (any kind). Changing an existing one needs the current password.
    if (request.method === 'POST' && url.pathname === '/password') {
      const account = await requireSession(request, env);
      if (!account) return json({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
      if (!validPassword(body && body.password)) return json({ error: 'invalid_password' }, 400);
      if (account.password_hash && !(typeof body.current_password === 'string' && await verifyPassword(body.current_password, account.password_hash))) {
        return json({ error: 'invalid_credentials' }, 401);
      }
      const passwordHash = await hashPassword(body.password);
      await env.DB.prepare('UPDATE accounts SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
        .bind(passwordHash, Date.now(), account.id).run();
      return json({ account: serializeAccount({ ...account, password_hash: passwordHash }) });
    }

    if (request.method === 'GET' && url.pathname === '/me') {
      const account = await requireSession(request, env);
      if (!account) return json({ error: 'unauthorized' }, 401);
      return json({ account: serializeAccount(account) });
    }

    if (request.method === 'POST' && url.pathname === '/nick') {
      const account = await requireSession(request, env);
      if (!account) return json({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
      const nick = sanitizeUsername(body && body.nick);
      const nickLower = nick.toLowerCase();

      const dup = await env.DB.prepare(
        'SELECT id FROM accounts WHERE nick_lower = ? AND id != ?'
      ).bind(nickLower, account.id).first();
      if (dup) return json({ error: 'nick_taken' }, 409);

      try {
        await env.DB.prepare(
          'UPDATE accounts SET nick = ?, nick_lower = ?, updated_at = ? WHERE id = ?'
        ).bind(nick, nickLower, Date.now(), account.id).run();
      } catch (error) {
        // The availability query is advisory: another account can claim the
        // name before this UPDATE. The UNIQUE index is the final arbiter.
        if (/UNIQUE constraint failed: accounts\.nick_lower\b/.test(String(error?.message))) {
          return json({ error: 'nick_taken' }, 409);
        }
        throw error;
      }

      return json({ account: serializeAccount({ ...account, nick }) });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/profile/')) {
      const id = url.pathname.slice('/profile/'.length);
      if (!id) return json({ error: 'not_found' }, 404);
      const account = await env.DB.prepare(
        'SELECT * FROM accounts WHERE id = ?'
      ).bind(id).first();
      if (!account) return json({ error: 'not_found' }, 404);
      return json({ profile: serializePublicProfile(account) });
    }

    if (request.method === 'PATCH' && url.pathname === '/profile') {
      const account = await requireSession(request, env);
      if (!account) return json({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ error: 'invalid_body' }, 400);
      }

      const unknownKeys = Object.keys(body).filter(key => !Object.hasOwn(PROFILE_FIELDS, key));
      if (unknownKeys.length > 0) {
        return json({ error: 'unknown_field', fields: unknownKeys }, 400);
      }

      const updates = {};
      for (const key of Object.keys(body)) {
        const raw = body[key];
        // Treat missing/undefined as "not present" (handled above); only
        // string or null are ever acceptable values for a profile field.
        if (raw !== null && typeof raw !== 'string') {
          return json({ error: 'invalid_field', field: key }, 400);
        }
        const result = PROFILE_FIELDS[key].validate(raw);
        if (!result.ok) return json({ error: 'invalid_field', field: key }, 400);
        updates[key] = result.value;
      }

      const keys = Object.keys(updates);
      if (keys.length === 0) return json({ account: serializeAccount(account) });

      const setClause = keys.map(key => `${key} = ?`).join(', ');
      const values = keys.map(key => updates[key]);
      await env.DB.prepare(
        `UPDATE accounts SET ${setClause}, updated_at = ? WHERE id = ?`
      ).bind(...values, Date.now(), account.id).run();

      return json({ account: serializeAccount({ ...account, ...updates }) });
    }

    if (request.method === 'POST' && url.pathname === '/logout') {
      const token = bearerToken(request);
      if (!token) return json({ error: 'unauthorized' }, 401);
      const tokenHash = await sha256Hex(token);
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
      return json({ ok: true });
    }

    return json({ error: 'not_found' }, 404);
}
