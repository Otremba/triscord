const io = require('socket.io-client');
const { server, getConfiguredTurnServers, getIceTransportPolicy, getBaseIceServers } = require('./server');

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

describe('TURN configuration', () => {
  test('parses multiple TURN URLs with shared credentials', () => {
    expect(getConfiguredTurnServers({
      TURN_URLS: 'turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349?transport=tcp',
      TURN_USERNAME: 'triscord-user',
      TURN_CREDENTIAL: 'temporary-secret'
    })).toEqual([{
      urls: [
        'turn:turn.example.com:3478?transport=udp',
        'turns:turn.example.com:5349?transport=tcp'
      ],
      username: 'triscord-user',
      credential: 'temporary-secret'
    }]);
  });

  test('returns no TURN server when none is configured', () => {
    expect(getConfiguredTurnServers({})).toEqual([]);
  });

  test('uses relay-only policy only when explicitly requested', () => {
    expect(getIceTransportPolicy({ ICE_TRANSPORT_POLICY: 'relay' })).toBe('relay');
    expect(getIceTransportPolicy({})).toBe('all');
  });

  test('keeps the built-in public TURN relay available by default', () => {
    const servers = getBaseIceServers({});
    expect(servers).toContainEqual(expect.objectContaining({
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject'
    }));
  });
});

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

function once(client, event) {
  return new Promise(resolve => client.once(event, resolve));
}

async function joinAs(roomId, userId, username) {
  const client = connect();
  await once(client, 'connect');
  const joined = once(client, 'room-joined');
  client.emit('join-room', { roomId, userData: { userId, username } });
  // The id is cleared when the server closes the socket, so keep a copy
  return { client, id: client.id, joined: await joined };
}

// Resolves once `client` has seen `event` for `socketId`
function seen(client, event, socketId) {
  return new Promise(resolve => {
    client.on(event, (payload) => {
      if (payload.socketId === socketId) resolve(payload);
    });
  });
}

describe('webrtc signalling', () => {
  test('relays session ids with an offer and drops malformed ones', async () => {
    const roomId = `room-${Date.now()}-e`;
    const a = await joinAs(roomId, 'sig-a', 'A');
    const b = await joinAs(roomId, 'sig-b', 'B');

    const offer = { type: 'offer', sdp: 'v=0' };
    const received = once(a.client, 'webrtc-offer');
    b.client.emit('webrtc-offer', { targetSocketId: a.client.id, offer, session: 'abc123', targetSession: 'bad id!' });

    expect(await received).toEqual({
      senderSocketId: b.client.id,
      offer,
      type: undefined,
      session: 'abc123',
      targetSession: undefined
    });

    a.client.close();
    b.client.close();
  }, 10000);
});

describe('stale sessions', () => {
  test('a user rejoining from a new socket replaces their old session', async () => {
    const roomId = `room-${Date.now()}-f`;
    const other = await joinAs(roomId, 'other-user', 'Other');
    const first = await joinAs(roomId, 'returning-user', 'Returning');

    const replaced = once(first.client, 'session-replaced');
    const oldSessionLeft = seen(other.client, 'user-left', first.id);

    const second = await joinAs(roomId, 'returning-user', 'Returning');

    // The rejoining client must not be told to connect to its own ghost
    expect(second.joined.existingUsers.map(u => u.userId)).toEqual(['other-user']);
    await replaced;
    await oldSessionLeft;

    other.client.close();
    first.client.close();
    second.client.close();
  }, 10000);

  test('a returning user gets back into a room that was locked meanwhile', async () => {
    const roomId = `room-${Date.now()}-g`;
    const owner = await joinAs(roomId, 'lock-owner', 'Owner');
    const guest = await joinAs(roomId, 'lock-guest', 'Guest');

    owner.client.emit('update-room-settings', { locked: true });
    await new Promise(resolve => setTimeout(resolve, 150));

    const again = await joinAs(roomId, 'lock-guest', 'Guest');
    expect(again.joined.roomId).toBe(roomId);

    owner.client.close();
    guest.client.close();
    again.client.close();
  }, 10000);

  test('re-joining the same room makes the others drop the old connection first', async () => {
    const roomId = `room-${Date.now()}-h`;
    const other = await joinAs(roomId, 'watcher', 'Watcher');
    const rejoiner = await joinAs(roomId, 'rejoiner', 'Rejoiner');
    await seen(other.client, 'user-joined', rejoiner.id);

    const events = [];
    other.client.on('user-left', ({ socketId }) => events.push(['left', socketId]));
    other.client.on('user-joined', ({ socketId }) => events.push(['joined', socketId]));

    const rejoined = once(rejoiner.client, 'room-joined');
    rejoiner.client.emit('join-room', { roomId, userData: { userId: 'rejoiner', username: 'Rejoiner' } });
    await rejoined;
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(events).toEqual([['left', rejoiner.id], ['joined', rejoiner.id]]);

    other.client.close();
    rejoiner.client.close();
  }, 10000);
});
