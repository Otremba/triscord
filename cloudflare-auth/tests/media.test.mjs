import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectImage, MEDIA_LIMITS } from '../src/profile-media.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
// Two complete image descriptors inside one GIF logical screen.
const animated = Buffer.concat([gif.subarray(0, -1), gif.subarray(19, -1), Buffer.from([0x3b])]);
assert.equal(inspectImage(png).mime, 'image/png');
assert.equal(inspectImage(animated).animated, true);
assert.equal(inspectImage(gif.subarray(0, 13)), null);
assert.equal(inspectImage(Buffer.from('<svg onload="alert(1)"></svg>')), null);
const hugePng = Buffer.from(png); hugePng.writeUInt32BE(100000, 16);
assert.equal(inspectImage(hugePng), null);
const manyFrames = Buffer.concat([gif.subarray(0, 19), ...Array(201).fill(gif.subarray(19, -1)), Buffer.from([0x3b])]);
assert.equal(inspectImage(manyFrames), null);

const mf = new Miniflare(convertV4MiniflareOptions({
  scriptPath: resolve(process.env.TRISCORD_AUTH_TEST_BUNDLE || 'out/worker.js'), modules: true, compatibilityDate: '2026-10-12',
  host: '127.0.0.1', port: 0, d1Databases: { DB: 'media-test' }
}));
try {
  const db = await mf.getD1Database('DB');
  const apply = async sql => {
    for (const statement of sql.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      try { await db.exec(statement); } catch (err) { if (!/duplicate column name/.test(err.message)) throw err; }
    }
  };
  await apply(readFileSync('schema.sql', 'utf8'));
  // Existing accounts survive the additive migration; applying against a
  // fresh schema with a migration-aware runner is harmless as well.
  await apply(readFileSync('migrations/0003_media.sql', 'utf8'));
  for (const [id, token] of [['owner', 'a'.repeat(64)], ['other', 'b'.repeat(64)]]) {
    await db.prepare('INSERT INTO accounts(id,email,created_at,updated_at) VALUES (?,?,?,?)').bind(id, `${id}@example.com`, 1, 1).run();
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
    await db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').bind(hash, id, 1, Date.now() + 60000).run();
  }
  const request = (path, { method = 'GET', token, data, mime = 'image/png', headers = {} } = {}) => mf.dispatchFetch(`https://auth.example${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': mime, ...headers }, body: data,
    ...(data instanceof ReadableStream ? { duplex: 'half' } : {})
  });
  const token = 'a'.repeat(64);
  assert.equal((await request('/profile/avatar', { method: 'PUT', data: png })).status, 401);
  assert.equal((await request('/profile/banner', { method: 'DELETE', token: 'c'.repeat(64) })).status, 401);
  for (const [data, mime] of [[png, 'image/gif'], [Buffer.from('<html>bad</html>'), 'image/png'], [gif.subarray(0, -1), 'image/gif'], [hugePng, 'image/png']]) {
    assert.equal((await request('/profile/avatar', { method: 'PUT', token, data, mime })).status, 415);
  }
  assert.equal((await request('/profile/avatar', { method: 'PUT', token, data: new Uint8Array(MEDIA_LIMITS.avatar + 1) })).status, 413);
  // Chunked request without Content-Length must obey the same limit.
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(300000)); controller.enqueue(new Uint8Array(300000)); controller.close();
  } });
  assert.equal((await request('/profile/avatar', { method: 'PUT', token, data: stream })).status, 413);
  const upload = await request('/profile/avatar', { method: 'PUT', token, data: animated, mime: 'image/gif' });
  assert.equal(upload.status, 200, await upload.clone().text());
  const first = await upload.json();
  assert.equal(first.media.animated, true);
  assert.equal(first.account.avatar_url, first.media.url);
  assert.equal(first.account.avatar_custom, undefined);
  assert.equal((await db.prepare('SELECT avatar_custom FROM accounts WHERE id=?').bind('owner').first()).avatar_custom, 1);
  const mediaPath = new URL(first.media.url).pathname;
  const served = await request(mediaPath);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/gif');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), animated);
  assert.equal((await request(mediaPath, { headers: { 'If-None-Match': served.headers.get('etag') } })).status, 304);
  const head = await request(mediaPath, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(animated.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await request(mediaPath.replace('/owner/', '/other/'))).status, 404);
  assert.equal((await request('/media/owner/avatar/' + '0'.repeat(64))).status, 404);
  assert.equal((await request('/profile/other/avatar', { method: 'DELETE', token: 'b'.repeat(64) })).status, 404);
  await request('/profile/avatar', { method: 'DELETE', token: 'b'.repeat(64) });
  assert.equal((await request(mediaPath)).status, 200); // deleting your own asset cannot delete another's

  const replaced = await (await request('/profile/avatar', { method: 'PUT', token, data: png })).json();
  assert.equal((await request(mediaPath)).status, 404);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM profile_media WHERE account_id=?').bind('owner').first()).n, 1);
  const banner = await request('/profile/banner', { method: 'PUT', token, data: gif, mime: 'image/gif' });
  assert.equal(banner.status, 200);
  const bannerUrl = (await banner.json()).account.banner_url;
  const publicProfile = await (await request('/profile/owner')).json();
  assert.equal(publicProfile.profile.banner_url, bannerUrl);
  assert.equal(publicProfile.profile.email, undefined);
  assert.equal(publicProfile.profile.note, undefined);
  for (const body of ['{"__proto__":null}', '{"constructor":"x"}', '{"avatar_url":"https://evil.test/x"}']) {
    assert.equal((await request('/profile', { method: 'PATCH', token, data: body, mime: 'application/json' })).status, 400);
  }

  // Populate the cap entirely inside SQLite without sending 64 MiB through
  // JS. Metadata and blob lengths remain consistent with schema checks.
  await db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<64) INSERT INTO accounts(id,email,created_at,updated_at) SELECT 'quota-'||x,'quota@example.com',1,1 FROM n");
  await db.exec("INSERT INTO profile_media SELECT id,'banner','quota','image/png',1048576,zeroblob(1048576),1 FROM accounts WHERE id LIKE 'quota-%'");
  const full = await request('/profile/banner', { method: 'PUT', token, data: png });
  assert.equal(full.status, 507);
  assert.equal((await (await request('/me', { token })).json()).account.banner_url, bannerUrl);
  await db.exec("DELETE FROM profile_media WHERE account_id LIKE 'quota-%'");

  assert.equal((await request('/profile/avatar', { method: 'DELETE', token })).status, 200);
  assert.equal((await request(new URL(replaced.media.url).pathname)).status, 404);
  assert.equal((await request('/profile/banner', { method: 'DELETE', token })).status, 200);
  assert.equal((await request('/profile/banner', { method: 'DELETE', token })).status, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM profile_media').first()).n, 0);
  console.log('PASS: media authentication, ownership, PNG/GIF containers, animation budget, MIME spoofing, streamed size cap, byte round-trip, caching, replacement/deletion, public privacy, storage cap, profile key validation');
} finally { await mf.dispose(); }
