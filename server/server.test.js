const io = require('socket.io-client');
const { server, soundLibrary, getConfiguredTurnServers, getIceTransportPolicy, getBaseIceServers } = require('./server');

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

describe('user state for newcomers', () => {
  test('someone joining later gets the PC health and app version already shared', async () => {
    const roomId = `room-${Date.now()}-v`;
    const first = await joinAs(roomId, 'state-a', 'A');
    const shared = seen(first.client, 'user-state-updated', first.id);
    first.client.emit('user-state-change', { appVersion: '1.1.7', pcHealth: { cpu: 50, ram: 40, gpu: 99, issues: ['gpu'] } });
    await shared;

    const later = await joinAs(roomId, 'state-b', 'B');
    const existing = later.joined.existingUsers.find(u => u.socketId === first.id);
    expect(existing).toMatchObject({ appVersion: '1.1.7', pcHealth: { cpu: 50, ram: 40, gpu: 99, issues: ['gpu'] } });

    first.client.close();
    later.client.close();
  }, 10000);
});

describe('screen-watch', () => {
  test('tells a sharer in the same room that a viewer stopped watching', async () => {
    const roomId = `room-${Date.now()}-w`;
    const sharer = await joinAs(roomId, 'watch-a', 'A');
    const viewer = await joinAs(roomId, 'watch-b', 'B');

    const received = once(sharer.client, 'screen-watch');
    viewer.client.emit('screen-watch', { targetSocketId: sharer.id, watching: false });
    expect(await received).toEqual({ senderSocketId: viewer.id, watching: false });

    const resumed = once(sharer.client, 'screen-watch');
    viewer.client.emit('screen-watch', { targetSocketId: sharer.id, watching: true });
    expect(await resumed).toEqual({ senderSocketId: viewer.id, watching: true });

    sharer.client.close();
    viewer.client.close();
  }, 10000);

  test('relays what a sharer sends a viewer, clamped, and drops unknown causes', async () => {
    const roomId = `room-${Date.now()}-s`;
    const sharer = await joinAs(roomId, 'stats-a', 'A');
    const viewer = await joinAs(roomId, 'stats-b', 'B');

    const received = once(viewer.client, 'screen-stats');
    sharer.client.emit('screen-stats', { targetSocketId: viewer.id, height: 1080.4, fps: 9999, cause: 'viewer-network' });
    expect(await received).toEqual({ senderSocketId: sharer.id, height: 1080, fps: 240, cause: 'viewer-network' });

    let relayed = false;
    viewer.client.on('screen-stats', () => { relayed = true; });
    sharer.client.emit('screen-stats', { targetSocketId: viewer.id, height: 720, fps: 30, cause: '<b>hack</b>' });
    await new Promise(r => setTimeout(r, 300));
    expect(relayed).toBe(false);

    sharer.client.close();
    viewer.client.close();
  }, 10000);

  test('is not relayed to someone in another room', async () => {
    const sharer = await joinAs(`room-${Date.now()}-w1`, 'watch-c', 'C');
    const outsider = await joinAs(`room-${Date.now()}-w2`, 'watch-d', 'D');

    let relayed = false;
    sharer.client.on('screen-watch', () => { relayed = true; });
    outsider.client.emit('screen-watch', { targetSocketId: sharer.id, watching: false });
    await new Promise(r => setTimeout(r, 300));
    expect(relayed).toBe(false);

    sharer.client.close();
    outsider.client.close();
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

describe('soundboard', () => {
  const crypto = require('crypto');
  // The library is global, so every test uses audio of its own
  function makeClip(label) {
    const data = Buffer.from(`fake mp3 bytes: ${label} ${Math.random()}`);
    return { data, id: crypto.createHash('sha256').update(data).digest('hex') };
  }

  async function connected() {
    const client = connect();
    await once(client, 'connect');
    return client;
  }

  test('plays a clip for the room and serves it to listeners (the 1.1.4 flow)', async () => {
    const clip = makeClip('play');
    const roomId = `room-${Date.now()}-sb1`;
    const player = await joinAs(roomId, 'sb-player', 'Player');
    const listener = await joinAs(roomId, 'sb-listener', 'Listener');

    // The server has never seen this clip, so it asks for the bytes
    expect(await player.client.emitWithAck('soundboard-play', { soundId: clip.id, name: 'Buzina' }))
      .toEqual({ ok: false, needData: true });

    // An id that is not the hash of the bytes is refused
    expect(await player.client.emitWithAck('soundboard-upload', { soundId: 'f'.repeat(64), mime: 'audio/mpeg', data: clip.data }))
      .toEqual({ ok: false, error: 'hash-mismatch' });

    const heard = once(listener.client, 'soundboard-played');
    const shared = once(listener.client, 'soundboard-library-changed');
    expect(await player.client.emitWithAck('soundboard-upload', {
      soundId: clip.id, mime: 'audio/mpeg', data: clip.data, name: '  Buzina\u0007 ', emoji: '\u{1F4EF}'
    })).toEqual({ ok: true });

    expect(await heard).toEqual({
      soundId: clip.id, name: 'Buzina', emoji: '\u{1F4EF}', bySocketId: player.id, byUsername: 'Player'
    });
    // A clip played by an app without the shared library joins it
    expect((await shared).entries).toEqual([expect.objectContaining({ id: clip.id, name: 'Buzina', addedBy: 'Player' })]);

    const fetched = await listener.client.emitWithAck('soundboard-fetch', { soundId: clip.id });
    expect(fetched.ok).toBe(true);
    expect(Buffer.from(fetched.data).equals(clip.data)).toBe(true);

    // Cached now: a play carries only the id
    await new Promise(resolve => setTimeout(resolve, 3100)); // past the play rate limit window
    expect(await player.client.emitWithAck('soundboard-play', { soundId: clip.id })).toEqual({ ok: true });

    player.client.close();
    listener.client.close();
  }, 10000);

  test('shares additions, renames and deletions with every app, in or out of a call', async () => {
    const clip = makeClip('library');
    const alice = await connected();
    const bob = await connected();

    // Adding needs the audio, so nobody can list a sound the server cannot serve
    expect(await alice.emitWithAck('soundboard-upsert', { entry: { id: clip.id, name: 'X', mime: 'audio/mpeg' } }))
      .toEqual({ ok: false, error: 'invalid' });

    const added = once(bob, 'soundboard-library-changed');
    const reply = await alice.emitWithAck('soundboard-upsert', {
      username: 'Alice',
      userId: 'user_alice',
      entry: { id: clip.id, name: 'Risada', emoji: '\u{1F602}', mime: 'audio/mpeg', addedBy: 'Mallory', addedById: 'user_mallory', addedAt: 1 },
      data: clip.data
    });
    expect(reply.ok).toBe(true);
    // The author comes from who is connected, never from the entry itself
    expect(reply.entry.addedById).toBe('user_alice');
    // The server decides who added it and when
    expect(reply.entry).toMatchObject({ name: 'Risada', addedBy: 'Alice', deleted: false });
    expect(reply.entry.addedAt).toBeGreaterThan(1);
    expect((await added).entries[0]).toMatchObject({ id: clip.id, name: 'Risada' });

    // Anyone can rename it
    const renamed = once(alice, 'soundboard-library-changed');
    await bob.emitWithAck('soundboard-upsert', { entry: { ...reply.entry, name: 'Risadona' } });
    expect((await renamed).entries[0]).toMatchObject({ name: 'Risadona', addedBy: 'Alice', addedById: 'user_alice' });

    // A newcomer gets the whole library on sync
    const carol = await connected();
    const synced = await carol.emitWithAck('soundboard-sync', { entries: [] });
    expect(synced.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: clip.id, name: 'Risadona' })]));

    // Anyone can delete it, and an app with an older copy cannot bring it back
    const deleted = once(bob, 'soundboard-library-changed');
    await carol.emitWithAck('soundboard-upsert', { entry: { ...reply.entry, deleted: true } });
    expect((await deleted).entries[0]).toMatchObject({ id: clip.id, deleted: true });

    const stale = await bob.emitWithAck('soundboard-sync', { entries: [{ ...reply.entry, updatedAt: reply.entry.updatedAt, hasData: true }] });
    expect(stale.entries.find(e => e.id === clip.id).deleted).toBe(true);
    expect(stale.missing).toEqual([]);

    [alice, bob, carol].forEach(c => c.close());
  }, 10000);

  test('gets lost audio back from the apps that hold it', async () => {
    const clip = makeClip('restart');
    const holder = await connected();
    const listener = await connected();
    await holder.emitWithAck('soundboard-upsert', {
      username: 'Holder', entry: { id: clip.id, name: 'Eco', mime: 'audio/mpeg' }, data: clip.data
    });

    // What a server restart does to the audio (the library comes back by sync)
    soundLibrary.dropClip(clip.id);

    // An app syncing with the audio is told to resend it
    const synced = await holder.emitWithAck('soundboard-sync', {
      entries: [{ id: clip.id, name: 'Eco', mime: 'audio/mpeg', updatedAt: 1, hasData: true }]
    });
    expect(synced.missing).toEqual([clip.id]);

    // A listener asking meanwhile is told to wait, and the apps are asked for it
    const asked = once(holder, 'soundboard-need-data');
    expect(await listener.emitWithAck('soundboard-fetch', { soundId: clip.id })).toEqual({ ok: false, error: 'pending' });
    expect(await asked).toEqual({ soundId: clip.id });

    expect(await holder.emitWithAck('soundboard-upload', { soundId: clip.id, mime: 'audio/mpeg', data: clip.data, play: false }))
      .toEqual({ ok: true });
    const fetched = await listener.emitWithAck('soundboard-fetch', { soundId: clip.id });
    expect(Buffer.from(fetched.data).equals(clip.data)).toBe(true);

    holder.close();
    listener.close();
  }, 10000);

  test('rejects bad clips, plays outside a call and spam', async () => {
    const clip = makeClip('spam');
    const roomId = `room-${Date.now()}-sb2`;
    const player = await joinAs(roomId, 'sb-spammer', 'Spammer');

    expect(await player.client.emitWithAck('soundboard-upload', { soundId: clip.id, mime: 'text/html', data: clip.data }))
      .toEqual({ ok: false, error: 'invalid-sound' });
    expect(await player.client.emitWithAck('soundboard-play', { soundId: 'not-a-hash' }))
      .toEqual({ ok: false, error: 'invalid' });

    expect(await player.client.emitWithAck('soundboard-upload', { soundId: clip.id, mime: 'audio/mpeg', data: clip.data }))
      .toEqual({ ok: true });
    expect(await player.client.emitWithAck('soundboard-play', { soundId: clip.id })).toEqual({ ok: true });
    expect(await player.client.emitWithAck('soundboard-play', { soundId: clip.id }))
      .toEqual({ ok: false, error: 'rate-limited' });

    // Someone outside a call can browse the library but not play into a room
    const outsider = await connected();
    expect((await outsider.emitWithAck('soundboard-fetch', { soundId: clip.id })).ok).toBe(true);
    expect(await outsider.emitWithAck('soundboard-play', { soundId: clip.id })).toEqual({ ok: false, error: 'invalid' });

    player.client.close();
    outsider.close();
  }, 10000);
});
