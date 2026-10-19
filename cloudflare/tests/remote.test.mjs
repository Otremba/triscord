// Explicit deployment acceptance only. Never executed by npm test or CI.
import assert from 'node:assert/strict';

const url = new URL(process.argv[2] || 'https://invalid.invalid');
assert(url.protocol === 'https:' && url.hostname.endsWith('.workers.dev') && !url.username && !url.password && !url.search && !url.hash,
  'Pass the deployed HTTPS workers.dev origin explicitly');
const invite = process.env.TRISCORD_TEST_INVITE;
assert(invite?.length >= 16, 'Set TRISCORD_TEST_INVITE privately; never pass it on the command line');
const health = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(10000) });
assert.equal(health.status, 200); assert.equal((await health.json()).service, 'triscord-native-control');
const endpoint = new URL('/socket.io/?EIO=4&transport=websocket', url); endpoint.protocol = 'wss:';

async function check(code, authorized) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    let joined = false, received = false, reacted = false, heartbeat = false;
    const timeout = setTimeout(() => finish(new Error('Remote control/heartbeat timeout')), 35000);
    const finish = error => { clearTimeout(timeout); socket.close(); error ? reject(error) : resolve(); };
    const marker = 'Validação de publicação ' + crypto.randomUUID();
    socket.addEventListener('error', () => finish(new Error('Remote WebSocket failed')));
    socket.addEventListener('message', event => {
      try {
        const packet = String(event.data);
        if (packet.startsWith('0')) socket.send('40' + JSON.stringify({ invite: code }));
        else if (packet.startsWith('44')) { assert(!authorized, 'Valid invitation rejected'); finish(); }
        else if (packet.startsWith('40')) {
          assert(authorized, 'Invalid invitation accepted');
          socket.send('42' + JSON.stringify(['join-room', { roomId:'native-validation', roomName:'Validação nativa',
            userData: { userId:crypto.randomUUID(), username:'Deployment check', isMuted:true } }]));
        } else if (packet === '2') { heartbeat = true; socket.send('3'); }
        else if (packet.startsWith('42[')) {
          const [name, data] = JSON.parse(packet.slice(2));
          if (name === 'room-joined') { joined = true; socket.send('42' + JSON.stringify(['send-chat-message', { message:marker }])); }
          else if (name === 'new-chat-message' && data.text === marker) {
            received = true; socket.send('42' + JSON.stringify(['add-reaction', { messageId:data.id, emoji:'👍' }]));
          } else if (name === 'message-reaction-updated') reacted = (data.reactions['👍']?.length || 0) > 0;
        }
        if (authorized && joined && received && reacted && heartbeat && packet === '6') finish();
      } catch (error) { finish(error); }
    });
    socket.addEventListener('close', () => {
      if (authorized && !(joined && received && reacted && heartbeat)) finish(new Error('Remote socket closed before acceptance'));
    });
  });
}
await check('invalid-test-invitation', false);
await check(invite, true);
console.log('PASS: deployed HTTPS, invitation rejection/acceptance, room, text, reaction and real heartbeat');
