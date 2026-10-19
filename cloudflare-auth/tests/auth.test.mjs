import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const bundlePath = resolve(process.env.TRISCORD_AUTH_TEST_BUNDLE || 'out/worker.js');
const schema = readFileSync(resolve('schema.sql'), 'utf8');
const profileMigration = readFileSync(resolve('migrations/0002_profile.sql'), 'utf8');
const mediaMigration = readFileSync(resolve('migrations/0003_media.sql'), 'utf8');

function toStatements(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Applies one migration statement at a time, tolerating "duplicate column
// name" (the column is already there) so re-running the same migration file
// against a database that has already been migrated is a no-op, not a crash.
async function applyMigrationIdempotently(db, sql) {
  for (const statement of toStatements(sql)) {
    try {
      await db.exec(statement);
    } catch (err) {
      if (!/duplicate column name/.test(err.message)) throw err;
    }
  }
}

function base64UrlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

// --- A tiny fake Google: its own RSA keypair, a JWKS endpoint serving the
// public half, and a signer for the private half, all offline. ---
async function makeFakeGoogle() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
  const otherKeyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const kid = 'test-key-1';
  const jwks = { keys: [{ ...publicJwk, kid, use: 'sig', alg: 'RS256' }] };

  async function sign(payloadOverrides, { key = keyPair.privateKey, headerKid = kid, alg = 'RS256' } = {}) {
    const header = { alg, kid: headerKid, typ: 'JWT' };
    const payload = {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: 'google-user-1',
      email: 'user@example.com',
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...payloadOverrides
    };
    const headerSeg = base64UrlEncodeJson(header);
    const payloadSeg = base64UrlEncodeJson(payload);
    const signedData = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, signedData));
    return `${headerSeg}.${payloadSeg}.${base64UrlEncode(signature)}`;
  }

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'public, max-age=3600');
    res.end(JSON.stringify(jwks));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const jwksUrl = `http://127.0.0.1:${port}/certs`;

  return { sign, jwksUrl, otherPrivateKey: otherKeyPair.privateKey, close: () => server.close() };
}

async function run() {
  const google = await makeFakeGoogle();
  const mf = new Miniflare(convertV4MiniflareOptions({
    scriptPath: bundlePath,
    modules: true,
    compatibilityDate: '2026-10-12',
    host: '127.0.0.1',
    port: 0,
    d1Databases: { DB: 'triscord-accounts-test' },
    bindings: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_JWKS_URL: google.jwksUrl }
  }));

  try {
    const db = await mf.getD1Database('DB');
    // D1's exec() treats each newline as a statement boundary, so strip SQL
    // comments and flatten every statement to a single line before exec'ing.
    const statements = schema
      .replace(/--[^\n]*/g, '')
      .split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    for (const statement of statements) {
      await db.exec(statement);
    }

    const fetchJson = async (path, init) => {
      const response = await mf.dispatchFetch(`http://localhost${path}`, init);
      let body = null;
      try { body = await response.json(); } catch { /* no body */ }
      return { status: response.status, body };
    };

    // Health check
    {
      const { status, body } = await fetchJson('/health');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.service, 'triscord-auth');
    }

    // Valid token -> account created, session returned, is_new true
    let session1;
    {
      const idToken = await google.sign({});
      const { status, body } = await fetchJson('/auth/google', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken })
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.ok(body.session);
      assert.ok(body.expires_at > Date.now());
      assert.equal(body.account.id, 'google-user-1');
      assert.equal(body.account.email, 'user@example.com');
      assert.equal(body.account.is_new, true);
      session1 = body.session;
    }

    // /me with the fresh session
    {
      const { status, body } = await fetchJson('/me', { headers: { Authorization: `Bearer ${session1}` } });
      assert.equal(status, 200);
      assert.equal(body.account.email, 'user@example.com');
      assert.equal(body.account.is_new, true); // no nick yet
    }

    // /nick sets a nick
    {
      const { status, body } = await fetchJson('/nick', {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${session1}` },
        body: JSON.stringify({ nick: 'Kevin' })
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.account.nick, 'Kevin');
      assert.equal(body.account.is_new, false);
    }

    // PATCH /profile updates a subset without clobbering other fields
    {
      const { status, body } = await fetchJson('/profile', {
        method: 'PATCH', headers: { 'content-type': 'application/json', Authorization: `Bearer ${session1}` },
        body: JSON.stringify({ bio: 'Hello there', pronouns: 'she/her' })
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.account.bio, 'Hello there');
      assert.equal(body.account.pronouns, 'she/her');
      assert.equal(body.account.display_name, null);

      const { status: status2, body: body2 } = await fetchJson('/profile', {
        method: 'PATCH', headers: { 'content-type': 'application/json', Authorization: `Bearer ${session1}` },
        body: JSON.stringify({ display_name: 'Kev' })
      });
      assert.equal(status2, 200, JSON.stringify(body2));
      assert.equal(body2.account.display_name, 'Kev');
      // Earlier fields survive an update that doesn't mention them
      assert.equal(body2.account.bio, 'Hello there');
      assert.equal(body2.account.pronouns, 'she/her');
    }

    // Oversized bio -> rejected
    {
      const { status, body } = await fetchJson('/profile', {
        method: 'PATCH', headers: { 'content-type': 'application/json', Authorization: `Bearer ${session1}` },
        body: JSON.stringify({ bio: 'x'.repeat(191) })
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'invalid_field');
      assert.equal(body.field, 'bio');
    }

    // Malformed color -> rejected
    {
      const { status, body } = await fetchJson('/profile', {
        method: 'PATCH', headers: { 'content-type': 'application/json', Authorization: `Bearer ${session1}` },
        body: JSON.stringify({ banner_color: 'not-a-color' })
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'invalid_field');
      assert.equal(body.field, 'banner_color');
    }

    // Valid color (set a banner and accent color for the public-profile check below)
    {
      const { status, body } = await fetchJson('/profile', {
        method: 'PATCH', headers: { 'content-type': 'application/json', Authorization: `Bearer ${session1}` },
        body: JSON.stringify({ banner_color: '#ABCDEF', note: 'secret reminder' })
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.account.banner_color, '#ABCDEF');
      assert.equal(body.account.note, 'secret reminder');
    }

    // Unknown key -> rejected
    {
      const { status, body } = await fetchJson('/profile', {
        method: 'PATCH', headers: { 'content-type': 'application/json', Authorization: `Bearer ${session1}` },
        body: JSON.stringify({ email: 'hacker@example.com' })
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'unknown_field');
      assert.deepEqual(body.fields, ['email']);
    }

    // PATCH /profile without a session -> 401
    {
      const { status, body } = await fetchJson('/profile', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bio: 'nope' })
      });
      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    }

    // GET /profile/:id is public, and does NOT leak email or the private note
    {
      const { status, body } = await fetchJson('/profile/google-user-1');
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.profile.id, 'google-user-1');
      assert.equal(body.profile.bio, 'Hello there');
      assert.equal(body.profile.display_name, 'Kev');
      assert.equal(body.profile.banner_color, '#ABCDEF');
      assert.equal('email' in body.profile, false);
      assert.equal('note' in body.profile, false);
    }

    // GET /profile/:id for an unknown account -> 404
    {
      const { status, body } = await fetchJson('/profile/no-such-account');
      assert.equal(status, 404);
      assert.equal(body.error, 'not_found');
    }

    // GET /me includes private fields (email, note) for the signed-in user
    {
      const { status, body } = await fetchJson('/me', { headers: { Authorization: `Bearer ${session1}` } });
      assert.equal(status, 200);
      assert.equal(body.account.email, 'user@example.com');
      assert.equal(body.account.note, 'secret reminder');
      assert.equal(body.account.bio, 'Hello there');
    }

    // Second login with the same sub -> same account, is_new false now that a nick is set
    {
      const idToken = await google.sign({});
      const { status, body } = await fetchJson('/auth/google', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken })
      });
      assert.equal(status, 200);
      assert.equal(body.account.id, 'google-user-1');
      assert.equal(body.account.nick, 'Kevin');
      assert.equal(body.account.is_new, false);
    }

    // A second account taking the same nick in a different case -> rejected
    {
      const idToken = await google.sign({ sub: 'google-user-2', email: 'second@example.com' });
      const loginRes = await fetchJson('/auth/google', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken })
      });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.account.is_new, true);
      const session2 = loginRes.body.session;
      const { status, body } = await fetchJson('/nick', {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${session2}` },
        body: JSON.stringify({ nick: 'kevin' }) // same nick, different case
      });
      assert.equal(status, 409);
      assert.equal(body.error, 'nick_taken');
    }

    // Wrong aud -> rejected
    {
      const idToken = await google.sign({ aud: 'someone-elses-client-id' });
      const { status, body } = await fetchJson('/auth/google', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken })
      });
      assert.equal(status, 401);
      assert.equal(body.error, 'bad_audience');
    }

    // Expired exp -> rejected
    {
      const idToken = await google.sign({ exp: Math.floor(Date.now() / 1000) - 10 });
      const { status, body } = await fetchJson('/auth/google', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken })
      });
      assert.equal(status, 401);
      assert.equal(body.error, 'expired_token');
    }

    // Bad signature (signed with a different key than the one in the JWKS) -> rejected
    {
      const idToken = await google.sign({}, { key: google.otherPrivateKey });
      const { status, body } = await fetchJson('/auth/google', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken })
      });
      assert.equal(status, 401);
      assert.equal(body.error, 'bad_signature');
    }

    // Unknown kid -> rejected
    {
      const idToken = await google.sign({}, { headerKid: 'no-such-key' });
      const { status, body } = await fetchJson('/auth/google', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken })
      });
      assert.equal(status, 401);
      assert.equal(body.error, 'unknown_kid');
    }

    // email_verified: false -> rejected
    {
      const idToken = await google.sign({ email_verified: false, sub: 'google-user-3', email: 'third@example.com' });
      const { status, body } = await fetchJson('/auth/google', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken })
      });
      assert.equal(status, 401);
      assert.equal(body.error, 'email_not_verified');
    }

    // /me with a garbage session -> 401
    {
      const { status, body } = await fetchJson('/me', { headers: { Authorization: 'Bearer not-a-real-session' } });
      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    }

    // /me with no Authorization header -> 401
    {
      const { status } = await fetchJson('/me');
      assert.equal(status, 401);
    }

    // Google re-authentication must not overwrite an uploaded avatar.
    {
      await db.prepare('UPDATE accounts SET avatar_url=?,avatar_custom=1 WHERE id=?')
        .bind('https://auth.example/media/custom-avatar', 'google-user-1').run();
      const { status, body } = await fetchJson('/auth/google', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id_token: await google.sign({ picture: 'https://google.example/default.jpg' }) })
      });
      assert.equal(status, 200);
      assert.equal(body.account.avatar_url, 'https://auth.example/media/custom-avatar');
      assert.equal((await db.prepare('SELECT avatar_url FROM accounts WHERE id=?').bind('google-user-1').first()).avatar_url,
        'https://auth.example/media/custom-avatar');
    }

    // /logout invalidates the session
    {
      const logoutRes = await fetchJson('/logout', { method: 'POST', headers: { Authorization: `Bearer ${session1}` } });
      assert.equal(logoutRes.status, 200);
      const { status, body } = await fetchJson('/me', { headers: { Authorization: `Bearer ${session1}` } });
      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    }

    // Expired session -> 401 (simulate by inserting an already-expired session row directly)
    {
      const expiredToken = 'a'.repeat(64);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expiredToken));
      const hashHex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      await db.prepare(
        'INSERT INTO sessions(token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
      ).bind(hashHex, 'google-user-1', Date.now() - 1000, Date.now() - 500).run();
      const { status, body } = await fetchJson('/me', { headers: { Authorization: `Bearer ${expiredToken}` } });
      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    }

    // migrations/0002_profile.sql is additive and idempotent: applying it
    // twice against a pre-profile-shaped `accounts` table must not error.
    {
      const legacyMf = new Miniflare(convertV4MiniflareOptions({
        scriptPath: bundlePath,
        modules: true,
        compatibilityDate: '2026-10-12',
        host: '127.0.0.1',
        port: 0,
        d1Databases: { DB: 'triscord-accounts-migration-test' },
        bindings: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_JWKS_URL: google.jwksUrl }
      }));
      try {
        const legacyDb = await legacyMf.getD1Database('DB');
        // The pre-profile shape (what schema.sql looked like before this change).
        await legacyDb.exec(
          'CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, nick TEXT, nick_lower TEXT UNIQUE, avatar_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)'
        );
        await legacyDb.prepare('INSERT INTO accounts(id,email,avatar_url,created_at,updated_at) VALUES (?,?,?,?,?)')
          .bind('legacy-user', 'legacy@example.com', 'https://google.example/avatar.png', 1, 1).run();
        await applyMigrationIdempotently(legacyDb, profileMigration);
        const afterFirst = await legacyDb.prepare("SELECT * FROM pragma_table_info('accounts')").all();
        const columnsAfterFirst = afterFirst.results.map(r => r.name).sort();

        // Applying it again must be a safe no-op, not an error.
        await applyMigrationIdempotently(legacyDb, profileMigration);
        const afterSecond = await legacyDb.prepare("SELECT * FROM pragma_table_info('accounts')").all();
        const columnsAfterSecond = afterSecond.results.map(r => r.name).sort();

        assert.deepEqual(columnsAfterSecond, columnsAfterFirst);
        for (const key of ['display_name', 'pronouns', 'bio', 'note', 'banner_color', 'nameplate',
          'avatar_decoration_url', 'display_name_style', 'profile_theme_start', 'profile_theme_end']) {
          assert.ok(columnsAfterFirst.includes(key), `missing column ${key}`);
        }
        await applyMigrationIdempotently(legacyDb, mediaMigration);
        await applyMigrationIdempotently(legacyDb, mediaMigration);
        const preserved = await legacyDb.prepare('SELECT * FROM accounts WHERE id=?').bind('legacy-user').first();
        assert.equal(preserved.email, 'legacy@example.com');
        assert.equal(preserved.avatar_url, 'https://google.example/avatar.png');
        assert.equal(preserved.avatar_custom, 0);
        assert.equal(preserved.banner_url, null);
        assert.equal((await legacyDb.prepare('SELECT COUNT(*) AS n FROM profile_media').first()).n, 0);
      } finally {
        await legacyMf.dispose();
      }
    }

    console.log('PASS: google id_token verification, account upsert, sessions, nick uniqueness, logout, profile fields, profile migration idempotency');
  } finally {
    await mf.dispose();
    google.close();
  }
}

await run();
