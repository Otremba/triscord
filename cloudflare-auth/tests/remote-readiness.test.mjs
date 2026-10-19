// Explicit production readiness check. No login, account reads, test users,
// TURN minting or authenticated writes. Not part of the offline npm test.
import assert from 'node:assert/strict';

const auth = process.env.TRISCORD_AUTH_URL || 'https://triscord-auth.triscord-cloudflare-control.workers.dev';
const hub = process.env.TRISCORD_HUB_URL || 'https://triscord-control.triscord-cloudflare-control.workers.dev';
async function check(base, path, status, key, expected, method = 'GET') {
  const response = await fetch(new URL(path, base), { method, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, `${method} ${path}`);
  assert.equal((await response.json())[key], expected, `${method} ${path}`);
}
await check(auth, '/health', 200, 'service', 'triscord-auth');
await check(auth, '/me', 401, 'error', 'unauthorized');
await check(auth, '/profile/avatar', 401, 'error', 'unauthorized', 'PUT');
await check(auth, '/profile/banner', 401, 'error', 'unauthorized', 'DELETE');
await check(hub, '/health', 200, 'service', 'triscord-native-control');
await check(hub, '/servers', 401, 'error', 'unauthorized');
await check(hub, '/ice', 401, 'error', 'unauthorized');
console.log('PASS: production auth/hub health and session gates for /me, profile media, /servers and /ice; no user data read or changed');
