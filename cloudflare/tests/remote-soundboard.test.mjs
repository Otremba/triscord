// Explicit production acceptance. Uses only the reserved, automatically deleted validation room.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const url = new URL(process.argv[2] || 'https://invalid.invalid');
assert.equal(url.origin, 'https://triscord-control.triscord-cloudflare-control.workers.dev');
const invite = (await readFile(new URL('../../desktop/out/cloudflare-group-invite.txt', import.meta.url), 'utf8')).trim();
assert(invite.length >= 16);
const catalog = JSON.parse(await readFile(new URL('../../shared/soundboard_catalog.json', import.meta.url), 'utf8'));
const endpoint = new URL('/socket.io/?EIO=4&transport=websocket', url); endpoint.protocol = 'wss:';
const clients = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(test, label) {
  const until = Date.now() + 12000;
  while (Date.now() < until) { if (test()) return; await sleep(50); }
  throw Error(label);
}
async function connect() {
  const c = { socket: new WebSocket(endpoint), events: [], sid: null, error: null };
  clients.push(c);
  c.send = (name, data) => c.socket.send('42' + JSON.stringify([name, data]));
  c.socket.addEventListener('error', () => { c.error = 'WebSocket error'; });
  c.socket.addEventListener('message', event => {
    const packet = String(event.data);
    if (packet.startsWith('0')) c.socket.send('40' + JSON.stringify({ invite }));
    else if (packet === '2') c.socket.send('3');
    else if (packet.startsWith('40')) c.sid = JSON.parse(packet.slice(2)).sid;
    else if (packet.startsWith('44')) c.error = 'Invitation rejected';
    else if (packet.startsWith('42[')) c.events.push(JSON.parse(packet.slice(2)));
  });
  await wait(() => c.sid || c.error, 'connection timeout'); assert(!c.error, c.error);
  await wait(() => c.events.some(([name]) => name === 'rooms-update'), 'directory timeout');
  const rooms = c.events.find(([name]) => name === 'rooms-update')[1];
  assert(!rooms.some(r => r.id === 'native-validation' && r.users?.length), 'Validation room occupied; aborting without joining');
  return c;
}
try {
  const a = await connect(), b = await connect(), outsider = await connect();
  for (const c of [a, b]) {
    c.send('join-room', { roomId: 'native-validation', roomName: 'Validação nativa',
      userData: { userId: crypto.randomUUID(), username: 'Soundboard check', isMuted: true } });
    await wait(() => c.events.some(([name]) => name === 'room-joined'), 'join timeout');
  }
  for (const [sender, id] of [[a, catalog[0].id], [b, catalog[1].id]]) {
    sender.send('soundboard-play', { soundId: id });
    for (const listener of [a, b]) {
      await wait(() => listener.events.some(([n, d]) => n === 'soundboard-played' && d.soundId === id), 'soundboard echo timeout');
      const received = listener.events.filter(([n, d]) => n === 'soundboard-played' && d.soundId === id);
      assert.equal(received.length, 1); assert.equal(received[0][1].roomId, 'native-validation');
      assert.equal(received[0][1].bySocketId, sender.sid);
    }
  }
  await sleep(300);
  assert(!outsider.events.some(([n]) => n === 'soundboard-played'));
  console.log('PASS: deployed soundboard broadcasts both directions, sender echo, exact room and sender, lobby isolation');
} finally {
  for (const c of clients) { if (c.socket.readyState === WebSocket.OPEN) { c.send('leave-room', {}); c.socket.close(); } else c.socket.close(); }
}
