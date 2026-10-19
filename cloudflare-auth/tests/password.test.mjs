import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Nick sign-in (POST /auth/nick) and setting the password later (POST /password), against the real bundle and D1.
const bundlePath = resolve(process.env.TRISCORD_AUTH_TEST_BUNDLE || 'out/worker.js');
const statements = readFileSync(resolve('schema.sql'), 'utf8').replace(/--[^\n]*/g, '')
  .split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

const mf = new Miniflare(convertV4MiniflareOptions({
  scriptPath: bundlePath, modules: true, compatibilityDate: '2026-10-12', host: '127.0.0.1', port: 0,
  d1Databases: { DB: 'triscord-password-test' }, bindings: { GOOGLE_CLIENT_ID: 'unused' }
}));
try {
  const db = await mf.getD1Database('DB');
  for (const statement of statements) await db.exec(statement);
  const call = async (path, body, session) => {
    const response = await mf.dispatchFetch(`http://localhost${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  // Nick only: account created, signed in, no password yet.
  const created = await call('/auth/nick', { nick: '  Amigo  ' });
  assert.equal(created.status, 201);
  assert.ok(created.body.session);
  assert.equal(created.body.account.nick, 'Amigo');
  assert.equal(created.body.account.has_password, false);
  assert.equal(created.body.account.google, false);
  assert.equal(created.body.account.is_new, false);
  assert.match(created.body.account.id, /^n_[0-9a-f]{24}$/);
  assert.equal((await call('/me', undefined, created.body.session)).body.account.nick, 'Amigo');

  // The nick is taken (case-insensitive) and cannot be signed into without a password.
  assert.deepEqual((await call('/auth/nick', { nick: 'amigo' })).body, { error: 'nick_taken' });
  assert.equal((await call('/auth/nick', { nick: 'amigo', password: 'qualquer' })).status, 409);
  assert.equal((await call('/auth/nick', { nick: 'x' })).status, 400);
  assert.equal((await call('/auth/nick', { nick: 'Outro', password: '123' })).status, 400);

  // Password set later, from the signed-in session; changing it needs the current one.
  assert.equal((await call('/password', { password: 'segredo1' })).status, 401);
  assert.equal((await call('/password', { password: '123' }, created.body.session)).status, 400);
  const set = await call('/password', { password: 'segredo1' }, created.body.session);
  assert.equal(set.status, 200);
  assert.equal(set.body.account.has_password, true);
  const stored = await db.prepare('SELECT password_hash FROM accounts WHERE id=?').bind(created.body.account.id).first();
  assert.match(stored.password_hash, /^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(!stored.password_hash.includes('segredo1'));
  assert.equal((await call('/password', { password: 'segredo2' }, created.body.session)).status, 401);
  assert.equal((await call('/password', { password: 'segredo2', current_password: 'errada' }, created.body.session)).status, 401);
  assert.equal((await call('/password', { password: 'segredo2', current_password: 'segredo1' }, created.body.session)).status, 200);

  // Another computer: nick + password signs in to the same account; a wrong or missing password does not.
  const again = await call('/auth/nick', { nick: 'AMIGO', password: 'segredo2' });
  assert.equal(again.status, 200);
  assert.equal(again.body.account.id, created.body.account.id);
  assert.notEqual(again.body.session, created.body.session);
  assert.deepEqual((await call('/auth/nick', { nick: 'Amigo' })).body, { error: 'password_required' });
  assert.deepEqual((await call('/auth/nick', { nick: 'Amigo', password: 'errada1' })).body, { error: 'invalid_credentials' });

  // Guessing is throttled: after 10 failures the account is locked, even for the right password.
  for (let i = 1; i < 10; i++) await call('/auth/nick', { nick: 'Amigo', password: `errada${i}x` });
  const locked = await call('/auth/nick', { nick: 'Amigo', password: 'segredo2' });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error, 'too_many_attempts');
  await db.prepare('UPDATE accounts SET locked_until=? WHERE id=?').bind(Date.now() - 1, created.body.account.id).run();
  assert.equal((await call('/auth/nick', { nick: 'Amigo', password: 'segredo2' })).status, 200);

  // Creating with a password at once works too.
  const withPassword = await call('/auth/nick', { nick: 'Segundo', password: 'senha123' });
  assert.equal(withPassword.status, 201);
  assert.equal(withPassword.body.account.has_password, true);
  assert.equal((await call('/auth/nick', { nick: 'segundo', password: 'senha123' })).status, 200);

  console.log('PASS: nick sign-in, nick uniqueness, password set later and changed, cross-device sign-in, guessing lockout');
} finally {
  await mf.dispose();
}
