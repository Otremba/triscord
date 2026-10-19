// Verify removed features cannot be accessed through the shared backend.
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const clientIo = require('socket.io-client');
global.fetch = async () => ({ ok: false });
const { server, io } = require('../../server/server');

function once(client, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { client.off(event, listener); reject(new Error(`Timeout: ${event}`)); }, 3000);
    function listener(data) { clearTimeout(timeout); resolve(data); }
    client.once(event, listener);
  });
}
function request(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}
async function main() {
  let client;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const health = await request(port, '/');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).client, 'desktop');
    for (const path of ['/index.html', '/style.css', '/js/app.js']) {
      assert.equal((await request(port, path)).status, 404);
    }
    client = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
    await once(client, 'connect');
    const joined = once(client, 'room-joined');
    client.emit('join-room', { roomId: 'feature-policy', userData: { userId: 'user_policy', username: 'Policy' } });
    await joined;
    const messages = [];
    client.on('new-chat-message', msg => messages.push(msg));
    // An image-only message must not be accepted. The following text event
    // is an ordered barrier on the same socket, with no arbitrary sleep.
    client.emit('send-chat-message', { attachment: { dataUrl: 'data:image/png;base64,aGVsbG8=' } });
    const received = once(client, 'new-chat-message');
    client.emit('send-chat-message', { message: 'Text stays', attachment: { dataUrl: 'data:image/png;base64,aGVsbG8=' } });
    const message = await received;
    assert.equal(messages.length, 1);
    assert.equal(message.text, 'Text stays');
    assert.equal(Object.hasOwn(message, 'attachment'), false);
    const reaction = once(client, 'message-reaction-updated');
    client.emit('add-reaction', { messageId: message.id, emoji: '👍' });
    assert.deepEqual((await reaction).reactions['👍'], ['user_policy']);
    const forced = once(client, 'force-muted'); client.emit('force-mute-user', { socketId: client.id });
    assert.equal((await forced).muted, true);
    const locked = once(client, 'user-state-updated'); client.emit('user-state-change', { isMuted: false, isServerMuted: false });
    assert.equal((await locked).state.isMuted, true);
    const mutedRejoin = once(client, 'room-joined');
    client.emit('join-room', { roomId: 'feature-policy', userData: { userId: 'user_policy', username: 'Policy', isMuted: false } });
    assert.equal((await mutedRejoin).isServerMuted, true);
    const released = once(client, 'force-muted'); client.emit('force-mute-user', { socketId: client.id, muted: false });
    assert.equal((await released).muted, false);
    const removed = once(client, 'chat-message-deleted');
    client.emit('delete-chat-message', { messageId: message.id });
    assert.equal((await removed).messageId, message.id);
    const replay = once(client, 'room-joined');
    client.emit('join-room', { roomId: 'feature-policy', userData: { userId: 'user_policy', username: 'Policy' } });
    assert.equal((await replay).chatHistory.length, 0);
    const bundled = require('../../shared/soundboard_catalog.json')[0];
    const playing = once(client, 'soundboard-played');
    const played = await client.timeout(3000).emitWithAck('soundboard-play', { soundId: bundled.id });
    assert.equal(played.ok, true);
    const sound = await playing; assert.equal(sound.soundId, bundled.id); assert.equal(sound.roomId, 'feature-policy');
    // The image ban and smaller transport limit must not disable audio files.
    const clip = Buffer.alloc(1024 * 1024, 1);
    const soundId = createHash('sha256').update(clip).digest('hex');
    const added = await client.timeout(3000).emitWithAck('soundboard-upsert', {
      entry: { id: soundId, name: 'Policy sound', mime: 'audio/mpeg' }, data: clip
    });
    assert.equal(added.ok, true);
    const fetched = await client.timeout(3000).emitWithAck('soundboard-fetch', { soundId });
    assert.equal(fetched.ok, true);
    assert.ok(Buffer.from(fetched.data).equals(clip));
    console.log('PASS: desktop-only health, web routes disabled, image-only chat rejected, text/reactions and 1 MB soundboard clips retained.');
  } finally {
    if (client) client.close();
    await new Promise(resolve => io.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
