// Local backend for the native end-to-end tests: the real auth and hub Workers (bundled from
// cloudflare-auth/ and cloudflare/ by run_e2e.py) in Miniflare, sharing one disposable D1 database, plus a
// fake Google OAuth/OIDC provider. Nothing reaches the internet or the production Workers.
//
// Usage: node backend.mjs <auth-bundle.js> <hub-bundle.js>
// Prints one JSON line {authUrl, hubUrl, googleAuthUrl, googleTokenUrl} and serves until killed.
//
// Fake Google:
//   GET  /auth?redirect_uri=..&state=..&e2e_user=<id>  -> 302 to redirect_uri?code=<id>&state=..
//   POST /token (code=<id>)                            -> {id_token} signed RS256 for sub <id>
//   GET  /certs                                        -> JWKS with the signing key
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(root, 'cloudflare/package.json'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const [authBundle, hubBundle] = process.argv.slice(2);
if (!authBundle || !hubBundle) throw new Error('usage: node backend.mjs <auth-bundle.js> <hub-bundle.js>');

// Same client id the native client sends (src/google_auth.cpp googleClientId()): the auth Worker checks aud.
const clientId = '250225176755-tdsas1pgo4b4ikbspqunik5v88i81rpi.apps.googleusercontent.com';
const key = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);

async function idToken(sub) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${encode({ alg: 'RS256', kid: 'native-e2e' })}.${encode({ iss: 'https://accounts.google.com',
    aud: clientId, sub, email: `${sub}@example.com`, email_verified: true, iat: now, exp: now + 3600 })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(signature).toString('base64url')}`;
}

const google = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/certs') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'native-e2e', alg: 'RS256', use: 'sig' }] }));
  }
  // Test-only shortcut (this server only exists on 127.0.0.1 during tests): a signed id_token for <sub>,
  // so a test can create accounts without driving a login screen.
  if (req.method === 'GET' && url.pathname === '/e2e-id-token') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ id_token: await idToken(url.searchParams.get('sub') || 'e2e-user') }));
  }
  if (req.method === 'GET' && url.pathname === '/auth') {
    const target = new URL(url.searchParams.get('redirect_uri'));
    if (target.hostname !== '127.0.0.1') { res.statusCode = 400; return res.end('loopback only'); }
    target.searchParams.set('code', url.searchParams.get('e2e_user') || 'e2e-user');
    target.searchParams.set('state', url.searchParams.get('state') || '');
    res.statusCode = 302; res.setHeader('location', target.toString()); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/token') {
    let body = ''; for await (const chunk of req) body += chunk;
    const code = new URLSearchParams(body).get('code');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ id_token: await idToken(code), token_type: 'Bearer', expires_in: 3600 }));
  }
  res.statusCode = 404; res.end();
});
await new Promise(done => google.listen(0, '127.0.0.1', done));
const googleOrigin = `http://127.0.0.1:${google.address().port}`;

// One ingress routes /auth-service/* and /hub-service/* to the two Workers (WebSocket upgrades included).
const ingress = `export default { fetch(request, env) {
  const url = new URL(request.url);
  // Public media URLs are rooted at /media even when the API is mounted under /auth-service.
  if (url.pathname.startsWith('/media/')) return env.AUTH.fetch(request);
  const auth = url.pathname.startsWith('/auth-service/');
  if (!auth && !url.pathname.startsWith('/hub-service/')) return new Response('Not found', { status: 404 });
  url.pathname = url.pathname.slice(auth ? 13 : 12);
  return (auth ? env.AUTH : env.CONTROL).fetch(new Request(url, request));
}}`;
const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, workers: [
  { name: 'entry', modules: true, script: ingress, compatibilityDate: '2026-10-12',
    serviceBindings: { AUTH: 'auth', CONTROL: 'control' } },
  { name: 'auth', modules: true, script: readFileSync(authBundle, 'utf8'), compatibilityDate: '2026-10-12',
    d1Databases: { DB: 'native-e2e-shared' },
    bindings: { GOOGLE_CLIENT_ID: clientId, GOOGLE_JWKS_URL: `${googleOrigin}/certs` } },
  { name: 'control', modules: true, script: readFileSync(hubBundle, 'utf8'), compatibilityDate: '2026-10-12',
    d1Databases: { DB: 'native-e2e-shared' }, bindings: { INVITE_CODE: 'native-e2e-legacy-invite' },
    durableObjects: { HUB: { className: 'TriscordHub', useSQLite: true } } },
] }));
const origin = (await mf.ready).origin.toString().replace(/\/$/, '');
const db = await mf.getD1Database('DB', 'auth');
for (const path of ['cloudflare-auth/schema.sql', 'cloudflare/migrations/0001_servers.sql']) {
  for (const sql of readFileSync(resolve(root, path), 'utf8').replace(/--[^\n]*/g, '').split(';')
    .map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(sql);
}
console.log(JSON.stringify({ authUrl: `${origin}/auth-service`, hubUrl: `${origin}/hub-service`,
  googleAuthUrl: `${googleOrigin}/auth`, googleTokenUrl: `${googleOrigin}/token` }));
const stop = async () => { await mf.dispose(); google.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.stdin.on('end', stop); process.stdin.resume(); // parent closing stdin ends the backend
