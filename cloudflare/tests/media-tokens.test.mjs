import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaCredentials, mediaMode, removeMediaParticipant } from '../src/media_tokens.js';
globalThis.crypto ??= webcrypto;
test('active calls keep their transport and empty calls negotiate capability', () => {
  assert.equal(mediaMode([], 'livekit', true), 'livekit');
  assert.equal(mediaMode([], 'livekit', false), 'mesh');
  assert.equal(mediaMode([{ data: {} }], 'livekit', true), 'mesh');
  assert.equal(mediaMode([{ data: { mediaTransport: 'livekit' } }], undefined, true), 'livekit');
});
test('cleanup targets only the departing generation in each media room', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: url.toString(), ...options }); return new Response('{}'); };
  try {
    await removeMediaParticipant({ LIVEKIT_URL: 'wss://media.example.org', LIVEKIT_API_KEY: 'unit-key', LIVEKIT_API_SECRET: 'unit-secret-only' },
      'server-a', 'geral', 'socket-a/generation-a');
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.url, 'https://media.example.org/twirp/livekit.RoomService/RemoveParticipant');
      const data = JSON.parse(call.body);
      assert.match(data.identity, /^socket-a\/generation-a\/(voice|screen|camera)$/);
      const claims = JSON.parse(Buffer.from(call.headers.Authorization.split('.')[1], 'base64url'));
      assert.equal(claims.video.room, data.room); assert.equal(claims.video.roomAdmin, true);
      assert.equal(claims.video.roomJoin, undefined);
    }
  } finally { globalThis.fetch = previous; }
});
test('media tokens isolate server, room, identity and source with a short admission window', async () => {
  const env = { LIVEKIT_URL: 'wss://media.example.org', LIVEKIT_API_KEY: 'unit-key', LIVEKIT_API_SECRET: 'unit-secret-only' };
  const creds = await mediaCredentials(env, 'server-a', 'geral', 'socket-a', 'José', 1000);
  for (const [kind, value] of Object.entries(creds)) {
    const [header, body, signature] = value.token.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url'));
    assert.equal(claims.sub, `socket-a/${kind}`);
    assert.equal(claims.video.room, `server-a:geral:${kind}`);
    assert.equal(claims.name, 'José'); assert.equal(claims.exp, 1060);
    assert.equal(claims.video.canPublishData, false);
    assert.equal(claims.video.roomAdmin, undefined);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LIVEKIT_API_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    assert.equal(await crypto.subtle.verify('HMAC', key, Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${body}`)), true);
  }
  assert.equal(await mediaCredentials({}, 'a', 'b', 'c', 'd'), null);
  await assert.rejects(mediaCredentials({ ...env, LIVEKIT_URL: 'ws://media.example.org' }, 'a', 'b', 'c', 'd'));
});
