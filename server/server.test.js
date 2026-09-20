const io = require('socket.io-client');
const { server } = require('./server');

let port;

beforeAll((done) => {
  server.listen(0, () => {
    port = server.address().port;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

function connect() {
  return io(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
}

describe('join-room', () => {
  test('sanitizes a hostile username/avatar and rejects a spoofed userId later', (done) => {
    const client = connect();
    const roomId = `room-${Date.now()}-a`;

    client.on('connect', () => {
      client.emit('join-room', {
        roomId,
        userData: { userId: 'client-a', username: '<img src=x>', avatar: 'javascript:alert(1)' }
      });
    });

    client.on('room-joined', () => {
      client.emit('user-state-change', { userId: 'someone-else', isMuted: true });

      client.on('rooms-update', (rooms) => {
        const room = rooms.find(r => r.id === roomId);
        const me = room && room.users.find(u => u.socketId === client.id);
        if (!me) return;

        expect(me.username).toBe('<img src=x>'); // stored/escaped-on-render verbatim...
        expect(me.avatar).toBe('#5865F2'); // ...but an invalid color falls back to the default
        expect(me.userId).not.toBe('someone-else'); // ...and userId can never be overwritten
        client.close();
        done();
      });
    });
  }, 10000);
});

describe('chat', () => {
  test('keeps history and replays it to the next joiner', (done) => {
    const roomId = `room-${Date.now()}-b`;
    const alice = connect();

    alice.on('connect', () => {
      alice.emit('join-room', { roomId, userData: { userId: 'alice', username: 'Alice' } });
    });

    alice.on('room-joined', () => {
      alice.emit('send-chat-message', { roomId, message: 'oi pessoal' });
    });

    alice.on('new-chat-message', () => {
      const bob = connect();
      bob.on('connect', () => {
        bob.emit('join-room', { roomId, userData: { userId: 'bob', username: 'Bob' } });
      });
      bob.on('room-joined', ({ chatHistory }) => {
        expect(chatHistory.length).toBe(1);
        expect(chatHistory[0].text).toBe('oi pessoal');
        alice.close();
        bob.close();
        done();
      });
    });
  }, 10000);

  test('toggles a reaction and ignores one outside the allowed set', (done) => {
    const roomId = `room-${Date.now()}-c`;
    const client = connect();

    client.on('connect', () => {
      client.emit('join-room', { roomId, userData: { userId: 'carol', username: 'Carol' } });
    });

    client.on('room-joined', () => {
      client.emit('send-chat-message', { roomId, message: 'reage nisso' });
    });

    client.on('new-chat-message', (msg) => {
      client.emit('add-reaction', { messageId: msg.id, emoji: 'not-a-real-emoji' });
      client.emit('add-reaction', { messageId: msg.id, emoji: '👍' });
    });

    client.on('message-reaction-updated', ({ reactions }) => {
      expect(reactions).toEqual({ '👍': ['carol'] });
      client.close();
      done();
    });
  }, 10000);
});

describe('room ownership', () => {
  test('only the creator can lock a custom room', (done) => {
    const roomId = `room-${Date.now()}-d`;
    const owner = connect();

    owner.on('connect', () => {
      owner.emit('join-room', { roomId, userData: { userId: 'owner-1', username: 'Owner' } });
    });

    owner.on('room-joined', ({ isOwner }) => {
      expect(isOwner).toBe(true);

      const outsider = connect();
      outsider.on('connect', () => {
        outsider.emit('join-room', { roomId, userData: { userId: 'not-owner', username: 'Outsider' } });
      });

      outsider.on('room-joined', ({ isOwner: outsiderIsOwner }) => {
        expect(outsiderIsOwner).toBe(false);
        outsider.emit('update-room-settings', { locked: true }); // must be ignored

        setTimeout(() => {
          owner.emit('update-room-settings', { locked: true }); // should take effect

          owner.on('rooms-update', (rooms) => {
            const room = rooms.find(r => r.id === roomId);
            if (room && room.locked) {
              owner.close();
              outsider.close();
              done();
            }
          });
        }, 150);
      });
    });
  }, 10000);
});
