const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const {
  sanitizeUsername,
  sanitizeUserId,
  sanitizeColor,
  sanitizeStatus,
  sanitizeMessageText,
  sanitizeRoomName,
  sanitizeAttachment,
  sanitizeUserStateUpdate,
  sanitizeSoundId,
  sanitizeSoundMeta,
  ALLOWED_REACTIONS
} = require('./sanitize');
const { SoundLibrary } = require('./sound-library');

const app = express();
app.use(cors());

// Serve static renderer files so friends can also join via browser if desired!
app.use(express.static(path.join(__dirname, '../src/renderer')));
app.use('/socket.io-client', express.static(path.join(__dirname, '../node_modules/socket.io-client/dist')));

// Metered TURN configuration & dynamic ICE servers resolution
const METERED_DOMAIN = process.env.METERED_DOMAIN || 'triscord.metered.live';
const METERED_SECRET_KEY = process.env.METERED_SECRET_KEY || 'lraG_4qQ2N9UDUjHsFeq9EGx5nPA22polekFNeXsgrnQ0npL';
const METERED_API_KEY = process.env.METERED_API_KEY || '';

const DEFAULT_TURN_SERVERS = [
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

function getConfiguredTurnServers(env = process.env) {
  const urls = String(env.TURN_URLS || '').split(',').map(url => url.trim()).filter(Boolean);
  if (!urls.length) return [];

  const server = { urls: urls.length === 1 ? urls[0] : urls };
  if (env.TURN_USERNAME) server.username = env.TURN_USERNAME;
  if (env.TURN_CREDENTIAL) server.credential = env.TURN_CREDENTIAL;
  return [server];
}

function getIceTransportPolicy(env = process.env) {
  return env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all';
}

function getBaseIceServers(env = process.env) {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    ...getConfiguredTurnServers(env),
    ...DEFAULT_TURN_SERVERS
  ];
}

function mergeIceServers(...groups) {
  const seen = new Set();
  return groups.flat().filter(server => {
    const key = JSON.stringify(server);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

let cachedIceServers = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 3600000; // 1 hour

async function getIceServers() {
  const now = Date.now();
  if (cachedIceServers && (now - lastFetchTime < CACHE_TTL_MS)) {
    return cachedIceServers;
  }

  const domain = process.env.METERED_DOMAIN || METERED_DOMAIN;
  const secretKey = process.env.METERED_SECRET_KEY || METERED_SECRET_KEY;
  const apiKey = process.env.METERED_API_KEY || METERED_API_KEY;
  const baseIceServers = getBaseIceServers();

  try {
    if (apiKey) {
      const res = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${apiKey}`);
      if (res.ok) {
        const servers = await res.json();
        if (Array.isArray(servers) && servers.length > 0) {
          cachedIceServers = mergeIceServers(baseIceServers, servers);
          lastFetchTime = now;
          return cachedIceServers;
        }
      }
    }

    if (secretKey) {
      const res = await fetch(`https://${domain}/api/v1/turn/credential?secretKey=${secretKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.apiKey) {
          const credRes = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${data.apiKey}`);
          if (credRes.ok) {
            const servers = await credRes.json();
            if (Array.isArray(servers) && servers.length > 0) {
              cachedIceServers = mergeIceServers(baseIceServers, servers);
              lastFetchTime = now;
              return cachedIceServers;
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[TURN] Failed to fetch Metered credentials:', err.message);
  }

  return baseIceServers;
}

app.get('/api/ice-servers', async (req, res) => {
  const iceServers = await getIceServers();
  res.json(iceServers);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e8 // 100MB for media/attachments if needed
});

const MAX_CHAT_HISTORY = 200;

// Rooms state: roomId -> { id, name, category, users: Map(socketId -> userData),
//   messages: [], ownerUserId, locked, maxUsers }
const defaultRooms = [
  { id: 'geral', name: 'Geral', category: 'Canais de Voz', type: 'voice' },
  { id: 'jogos', name: 'Jogos & Gameplay', category: 'Canais de Voz', type: 'voice' },
  { id: 'cinema', name: 'Cinema & Streams', category: 'Canais de Voz', type: 'voice' },
  { id: 'musica', name: 'Lounge / Música', category: 'Canais de Voz', type: 'voice' },
  { id: 'reuniao', name: 'Sala de Foco', category: 'Canais de Voz', type: 'voice' }
];

const rooms = new Map();
defaultRooms.forEach(r => {
  // Default rooms have no owner: nobody can lock them or kick from them
  rooms.set(r.id, { ...r, users: new Map(), messages: [], ownerUserId: null, locked: false, maxUsers: null });
});

// The soundboard library is shared by everyone on the server (see
// sound-library.js); the clients keep it, the server merges and relays it.
const soundLibrary = new SoundLibrary();
// soundId -> when the apps were last asked to resend its audio
const soundDataRequests = new Map();
const SOUND_DATA_REQUEST_INTERVAL_MS = 5000;

function requestClipFromClients(soundId) {
  const last = soundDataRequests.get(soundId) || 0;
  if (Date.now() - last < SOUND_DATA_REQUEST_INTERVAL_MS) return;
  soundDataRequests.set(soundId, Date.now());
  io.emit('soundboard-need-data', { soundId });
}

// A tiny sliding-window limiter so one client can't flood the room with chat
function makeRateLimiter(maxEvents, windowMs) {
  const hits = [];
  return function allow() {
    const now = Date.now();
    while (hits.length && now - hits[0] > windowMs) hits.shift();
    if (hits.length >= maxEvents) return false;
    hits.push(now);
    return true;
  };
}

function publicUser(u, sockId) {
  return {
    socketId: sockId,
    userId: u.userId,
    username: u.username,
    avatar: u.avatar,
    status: u.status || '',
    isMuted: u.isMuted || false,
    isDeafened: u.isDeafened || false,
    isCameraOn: u.isCameraOn || false,
    isScreenSharing: u.isScreenSharing || false,
    isSpeaking: u.isSpeaking || false,
    // Sent through user-state-change; someone joining later needs them too
    pcHealth: u.pcHealth || null,
    appVersion: u.appVersion || null
  };
}

// Helper: get list of all rooms with connected user summaries
function getRoomsSummary() {
  const list = [];
  rooms.forEach((r, id) => {
    const userList = [];
    r.users.forEach((u, sockId) => userList.push(publicUser(u, sockId)));
    list.push({
      id: r.id,
      name: r.name,
      category: r.category,
      type: r.type,
      userCount: r.users.size,
      users: userList,
      locked: !!r.locked,
      maxUsers: r.maxUsers || null,
      ownerUserId: r.ownerUserId || null
    });
  });
  return list;
}

// Each end of a peer connection tags its signalling with a random session id so
// the other end can tell a fresh connection from a renegotiation of the old one,
// and drop messages meant for a connection that no longer exists.
function sanitizeSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

function relaySignal(socket, event, targetSocketId, payload) {
  if (typeof targetSocketId !== 'string') return;
  io.to(targetSocketId).emit(event, {
    senderSocketId: socket.id,
    ...payload,
    session: sanitizeSessionId(payload.session),
    targetSession: sanitizeSessionId(payload.targetSession)
  });
}

function addReactionToggle(message, emoji, userId) {
  if (!message.reactions) message.reactions = {};
  const list = message.reactions[emoji] || [];
  const idx = list.indexOf(userId);
  if (idx === -1) list.push(userId);
  else list.splice(idx, 1);
  if (list.length) message.reactions[emoji] = list;
  else delete message.reactions[emoji];
  return message.reactions;
}

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Send current room list and user state on connect
  socket.emit('rooms-update', getRoomsSummary());

  // Provide TURN/STUN ICE servers to connected client
  getIceServers().then(iceServers => {
    socket.emit('ice-servers', iceServers, getIceTransportPolicy());
  }).catch(() => {});

  let currentRoomId = null;
  let currentUserData = null;
  const chatLimiter = makeRateLimiter(6, 4000);
  const reactionLimiter = makeRateLimiter(20, 4000);
  const soundPlayLimiter = makeRateLimiter(2, 3000);
  // Generous: after a server restart one app may resend the whole library,
  // and a new app downloads all of it
  const soundUploadLimiter = makeRateLimiter(120, 60000);
  const soundFetchLimiter = makeRateLimiter(240, 60000);
  const soundSyncLimiter = makeRateLimiter(5, 60000);
  const soundEditLimiter = makeRateLimiter(30, 60000);

  function isOwner(room) {
    return !!room && !!room.ownerUserId && !!currentUserData && room.ownerUserId === currentUserData.userId;
  }

  // Handle joining a voice/video room
  socket.on('join-room', ({ roomId, userData } = {}) => {
    if (typeof roomId !== 'string' || !roomId.trim()) return;
    roomId = roomId.trim().toLowerCase().slice(0, 64);

    // Leave the current room first — even when re-joining the same one: the
    // client has torn its peer connections down, so the others must drop theirs
    // too, or they would try to renegotiate a connection that no longer exists
    if (currentRoomId) {
      leaveCurrentRoom();
    }

    const isNewRoom = !rooms.has(roomId);
    if (isNewRoom) {
      const label = sanitizeRoomName(roomId.charAt(0).toUpperCase() + roomId.slice(1)) || 'Sala';
      rooms.set(roomId, {
        id: roomId,
        name: label,
        category: 'Canais Personalizados',
        type: 'voice',
        users: new Map(),
        messages: [],
        // The first person to create a custom room owns it (kick/mute/lock rights)
        ownerUserId: (userData && userData.userId) || null,
        locked: false,
        maxUsers: null
      });
    }

    const room = rooms.get(roomId);
    const requestingUserId = typeof (userData && userData.userId) === 'string'
      ? userData.userId.slice(0, 64)
      : null;

    // A client that reconnects gets a new socket id, while the server may not
    // notice the old socket is dead for up to a minute. Until then the others
    // keep a silent ghost of this user, and the rejoining client would offer a
    // peer connection to its own ghost.
    const staleSessions = [];
    if (requestingUserId) {
      room.users.forEach((u, sId) => {
        if (sId !== socket.id && u.userId === requestingUserId) staleSessions.push(sId);
      });
    }
    // Someone who was already in the room is coming back, not a new arrival
    const isReturning = staleSessions.length > 0;

    if (!isNewRoom && !isReturning && room.locked && room.ownerUserId !== requestingUserId) {
      socket.emit('room-join-denied', { roomId, reason: 'locked' });
      return;
    }
    if (!isNewRoom && !isReturning && room.maxUsers && room.users.size >= room.maxUsers &&
        room.ownerUserId !== requestingUserId) {
      socket.emit('room-join-denied', { roomId, reason: 'full' });
      return;
    }

    staleSessions.forEach(sId => {
      const u = room.users.get(sId);
      const stale = io.sockets.sockets.get(sId);
      if (stale) {
        stale.emit('session-replaced');
        stale.disconnect(true); // its disconnect handler leaves the room
      }
      if (room.users.has(sId)) {
        room.users.delete(sId);
        io.to(roomId).emit('user-left', { socketId: sId, username: u ? u.username : 'Usuário' });
      }
      console.log(`[Join] Dropped stale session ${sId} of ${u ? u.username : requestingUserId} in #${roomId}`);
    });

    currentRoomId = roomId;
    currentUserData = {
      userId: requestingUserId || `anon_${socket.id}`,
      username: sanitizeUsername(userData && userData.username),
      avatar: sanitizeColor(userData && userData.avatar),
      status: sanitizeStatus(userData && userData.status),
      isMuted: !!(userData && userData.isMuted),
      isDeafened: !!(userData && userData.isDeafened),
      isCameraOn: !!(userData && userData.isCameraOn),
      isScreenSharing: !!(userData && userData.isScreenSharing),
      isSpeaking: false,
      socketId: socket.id,
      joinedAt: Date.now()
    };

    socket.join(roomId);

    // Get all other existing users in this room to initiate WebRTC offers
    const existingUsers = [];
    room.users.forEach((u, sId) => existingUsers.push(publicUser(u, sId)));

    // Add current user to room
    room.users.set(socket.id, currentUserData);

    // 1. Tell the joining user who is already in the room + room settings + chat history
    socket.emit('room-joined', {
      roomId,
      existingUsers,
      chatHistory: room.messages,
      ownerUserId: room.ownerUserId,
      isOwner: isOwner(room),
      locked: !!room.locked,
      maxUsers: room.maxUsers || null
    });

    // 2. Notify all existing peers in the room that a new user joined
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userData: publicUser(currentUserData, socket.id)
    });

    // 3. Broadcast updated global room directory to everyone
    io.emit('rooms-update', getRoomsSummary());
    console.log(`[Join] ${currentUserData.username} joined room #${roomId} (${room.users.size} online)`);
  });

  // WebRTC signalling is relayed verbatim to the target socket
  socket.on('webrtc-offer', ({ targetSocketId, offer, type, session, targetSession } = {}) => {
    relaySignal(socket, 'webrtc-offer', targetSocketId, { offer, type, session, targetSession });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer, type, session, targetSession } = {}) => {
    relaySignal(socket, 'webrtc-answer', targetSocketId, { answer, type, session, targetSession });
  });

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate, type, session, targetSession } = {}) => {
    relaySignal(socket, 'webrtc-ice-candidate', targetSocketId, { candidate, type, session, targetSession });
  });

  // A viewer telling a screen sharer whether it is watching, so the sharer
  // stops encoding and uploading for someone who is not. Same room only.
  socket.on('screen-watch', ({ targetSocketId, watching } = {}) => {
    if (!currentRoomId || typeof targetSocketId !== 'string' || targetSocketId === socket.id) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.users.has(socket.id) || !room.users.has(targetSocketId)) return;
    io.to(targetSocketId).emit('screen-watch', { senderSocketId: socket.id, watching: watching !== false });
  });

  // A sharer telling a viewer what its screen share reaches them at and why,
  // so the viewer can tell their own connection from the sharer's
  const SCREEN_SEND_CAUSES = ['ok', 'sender-cpu', 'sender-upload', 'viewer-network', 'network'];
  socket.on('screen-stats', ({ targetSocketId, height, fps, cause } = {}) => {
    if (!currentRoomId || typeof targetSocketId !== 'string' || targetSocketId === socket.id) return;
    if (!SCREEN_SEND_CAUSES.includes(cause)) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.users.has(socket.id) || !room.users.has(targetSocketId)) return;
    const clamp = (value, max) => (Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0);
    io.to(targetSocketId).emit('screen-stats', {
      senderSocketId: socket.id, height: clamp(height, 4320), fps: clamp(fps, 240), cause
    });
  });

  // User state updates (mute, camera toggle, screenshare toggle, speaking indicator, profile)
  socket.on('user-state-change', (stateUpdate) => {
    if (!currentRoomId || !currentUserData) return;

    const room = rooms.get(currentRoomId);
    if (room && room.users.has(socket.id)) {
      const clean = sanitizeUserStateUpdate(stateUpdate);
      if (Object.keys(clean).length === 0) return;

      const user = room.users.get(socket.id);
      Object.assign(user, clean);
      Object.assign(currentUserData, clean);

      // Notify room members
      io.to(currentRoomId).emit('user-state-updated', {
        socketId: socket.id,
        state: clean
      });

      // Update global room lists if mute/camera/screen changed (PC health
      // and app version, sent every few seconds, never show there)
      if (Object.keys(clean).some(key => key !== 'pcHealth' && key !== 'appVersion')) {
        io.emit('rooms-update', getRoomsSummary());
      }
    }
  });

  // Text Chat Messages in Room (optionally carrying one small image attachment)
  socket.on('send-chat-message', ({ message, roomId, attachment } = {}) => {
    const targetRoom = roomId || currentRoomId;
    if (!targetRoom || !rooms.has(targetRoom)) return;

    const text = sanitizeMessageText(message);
    const cleanAttachment = sanitizeAttachment(attachment);
    if (!text && !cleanAttachment) return;
    if (!chatLimiter()) {
      socket.emit('chat-rate-limited');
      return;
    }

    const room = rooms.get(targetRoom);
    const chatPayload = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      roomId: targetRoom,
      senderSocketId: socket.id,
      senderUserId: currentUserData ? currentUserData.userId : null,
      senderName: currentUserData ? currentUserData.username : 'Anônimo',
      senderAvatar: currentUserData ? currentUserData.avatar : '',
      text,
      attachment: cleanAttachment,
      reactions: {},
      timestamp: Date.now()
    };

    room.messages.push(chatPayload);
    if (room.messages.length > MAX_CHAT_HISTORY) room.messages.shift();

    io.to(targetRoom).emit('new-chat-message', chatPayload);
  });

  // Toggle an emoji reaction on a message
  socket.on('add-reaction', ({ messageId, emoji } = {}) => {
    if (!currentRoomId || !currentUserData) return;
    if (!ALLOWED_REACTIONS.includes(emoji)) return;
    if (!reactionLimiter()) return;

    const room = rooms.get(currentRoomId);
    if (!room) return;
    const message = room.messages.find(m => m.id === messageId);
    if (!message) return;

    const reactions = addReactionToggle(message, emoji, currentUserData.userId);
    io.to(currentRoomId).emit('message-reaction-updated', {
      roomId: currentRoomId,
      messageId,
      reactions
    });
  });

  // Soundboard ---------------------------------------------------------
  // One library for everyone, kept by the apps and merged here (see
  // sound-library.js). A clip is identified by the SHA-256 of its bytes:
  // playing sends only that id, and the bytes travel once to the server and
  // once to each app.

  function currentRoomForSound() {
    return currentRoomId && currentUserData ? rooms.get(currentRoomId) : null;
  }

  // Before joining a room the app has no user data yet, so it says who it is
  function soundUsername(payload) {
    return currentUserData ? currentUserData.username : sanitizeUsername(payload && payload.username);
  }

  function soundUserId(payload) {
    return currentUserData ? sanitizeUserId(currentUserData.userId) : sanitizeUserId(payload && payload.userId);
  }

  function announceLibraryChanges(entries) {
    if (entries.length) socket.broadcast.emit('soundboard-library-changed', { entries });
  }

  function broadcastSound(room, soundId, meta) {
    const { name, emoji } = sanitizeSoundMeta(meta);
    io.to(room.id).emit('soundboard-played', {
      soundId,
      name,
      emoji,
      bySocketId: socket.id,
      byUsername: currentUserData.username
    });
  }

  // An app connecting sends everything it knows and gets the merged library
  // back, plus the audio the server is missing and the app can resend
  socket.on('soundboard-sync', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!soundSyncLimiter()) return reply({ ok: false, error: 'rate-limited' });

    const raw = payload && Array.isArray(payload.entries) ? payload.entries.slice(0, 2000) : [];
    const changed = [];
    const withData = [];
    raw.forEach((item) => {
      const entry = SoundLibrary.sanitizeEntry(item);
      if (!entry) return;
      if (item.hasData === true) withData.push(entry.id);
      const stored = soundLibrary.merge(entry);
      if (stored) changed.push(stored);
    });

    announceLibraryChanges(changed);
    reply({ ok: true, entries: soundLibrary.snapshot(), missing: soundLibrary.missingClips(withData) });
  });

  // Add, rename or delete a sound for everyone
  socket.on('soundboard-upsert', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!payload || typeof payload !== 'object') return reply({ ok: false, error: 'invalid' });
    if (!soundEditLimiter()) return reply({ ok: false, error: 'rate-limited' });

    // The server's clock decides which edit is the latest
    const now = Date.now();
    const entry = SoundLibrary.sanitizeEntry({ ...payload.entry, updatedAt: now }, now);
    if (!entry) return reply({ ok: false, error: 'invalid' });

    const isNew = !soundLibrary.entries.has(entry.id);
    if (isNew) {
      // Nobody can add a sound the server cannot serve
      if (entry.deleted || !payload.data) return reply({ ok: false, error: 'invalid' });
      entry.addedAt = now;
      entry.addedBy = soundUsername(payload);
      entry.addedById = soundUserId(payload);
    }
    if (payload.data && !entry.deleted) {
      if (!soundUploadLimiter()) return reply({ ok: false, error: 'rate-limited' });
      const error = soundLibrary.storeClip(entry.id, entry.mime, payload.data);
      if (error) return reply({ ok: false, error });
    }

    const stored = soundLibrary.merge(entry);
    if (!stored) return reply({ ok: false, error: isNew ? 'library-full' : 'stale' });
    announceLibraryChanges([stored]);
    reply({ ok: true, entry: stored });
  });

  socket.on('soundboard-play', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = currentRoomForSound();
    const soundId = sanitizeSoundId(payload && payload.soundId);
    if (!room || !soundId) return reply({ ok: false, error: 'invalid' });

    // Asking for the upload does not count against the play limit
    if (!soundLibrary.getClip(soundId)) return reply({ ok: false, needData: true });
    if (!soundPlayLimiter()) return reply({ ok: false, error: 'rate-limited' });

    broadcastSound(room, soundId, payload);
    reply({ ok: true });
  });

  // Audio for a sound: answering needData before a play, or resending what
  // the server lost (play: false). Version 1.1.4 apps only ever send this,
  // so a sound they play joins the shared library here.
  socket.on('soundboard-upload', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const soundId = sanitizeSoundId(payload && payload.soundId);
    if (!soundId) return reply({ ok: false, error: 'invalid' });
    if (!soundUploadLimiter()) return reply({ ok: false, error: 'rate-limited' });

    const error = soundLibrary.storeClip(soundId, payload.mime, payload.data);
    if (error) return reply({ ok: false, error });
    soundDataRequests.delete(soundId);

    if (!soundLibrary.entries.has(soundId)) {
      const now = Date.now();
      const entry = SoundLibrary.sanitizeEntry({
        ...payload, id: soundId, addedBy: soundUsername(payload), addedById: soundUserId(payload), addedAt: now, updatedAt: now
      }, now);
      const stored = entry && soundLibrary.merge(entry);
      if (stored) announceLibraryChanges([stored]);
    }

    if (payload.play === false) return reply({ ok: true });
    const room = currentRoomForSound();
    if (!room) return reply({ ok: false, error: 'invalid' });
    if (!soundPlayLimiter()) return reply({ ok: false, error: 'rate-limited' });
    broadcastSound(room, soundId, payload);
    reply({ ok: true });
  });

  socket.on('soundboard-fetch', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const soundId = sanitizeSoundId(payload && payload.soundId);
    if (!soundId) return ack({ ok: false, error: 'not-found' });
    if (!soundFetchLimiter()) return ack({ ok: false, error: 'rate-limited' });

    const clip = soundLibrary.getClip(soundId);
    if (clip) return ack({ ok: true, mime: clip.mime, data: clip.data });
    // Lost on a restart or evicted: some app still has it
    if (soundLibrary.isActive(soundId)) {
      requestClipFromClients(soundId);
      return ack({ ok: false, error: 'pending' });
    }
    ack({ ok: false, error: 'not-found' });
  });

  // Room owner controls -------------------------------------------------

  socket.on('kick-user', ({ socketId } = {}) => {
    if (!currentRoomId || typeof socketId !== 'string') return;
    const room = rooms.get(currentRoomId);
    if (!isOwner(room) || !room.users.has(socketId) || socketId === socket.id) return;

    const target = room.users.get(socketId);
    room.users.delete(socketId);

    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit('kicked', { roomId: currentRoomId, byUsername: currentUserData.username });
      targetSocket.leave(currentRoomId);
    }

    io.to(currentRoomId).emit('user-left', { socketId, username: target ? target.username : 'Usuário' });
    io.emit('rooms-update', getRoomsSummary());
    console.log(`[Kick] ${currentUserData.username} removed ${target ? target.username : socketId} from #${currentRoomId}`);
  });

  socket.on('force-mute-user', ({ socketId } = {}) => {
    if (!currentRoomId || typeof socketId !== 'string') return;
    const room = rooms.get(currentRoomId);
    if (!isOwner(room) || !room.users.has(socketId)) return;

    const target = room.users.get(socketId);
    target.isMuted = true;

    io.to(currentRoomId).emit('user-state-updated', { socketId, state: { isMuted: true } });
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) targetSocket.emit('force-muted', { byUsername: currentUserData.username });
    io.emit('rooms-update', getRoomsSummary());
  });

  socket.on('update-room-settings', ({ locked, maxUsers } = {}) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!isOwner(room)) return;

    if (typeof locked === 'boolean') room.locked = locked;
    if (maxUsers === null) room.maxUsers = null;
    else if (Number.isFinite(maxUsers) && maxUsers >= 1 && maxUsers <= 50) room.maxUsers = Math.floor(maxUsers);

    io.emit('rooms-update', getRoomsSummary());
  });

  // User explicitly leaves room
  socket.on('leave-room', () => {
    leaveCurrentRoom();
  });

  function leaveCurrentRoom() {
    if (!currentRoomId) return;

    const room = rooms.get(currentRoomId);
    if (room) {
      room.users.delete(socket.id);
      socket.leave(currentRoomId);

      socket.to(currentRoomId).emit('user-left', {
        socketId: socket.id,
        username: currentUserData ? currentUserData.username : 'Usuário'
      });
      console.log(`[Leave] ${currentUserData?.username || socket.id} left room #${currentRoomId}`);
    }

    currentRoomId = null;
    io.emit('rooms-update', getRoomsSummary());
  }

  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected] ID: ${socket.id}`);
    leaveCurrentRoom();
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`🚀 Servidor Triscord Ativo!`);
    console.log(`📡 Porta: ${PORT}`);
    console.log(`🔗 Local: http://localhost:${PORT}`);
    console.log(`=========================================`);
  });
}

module.exports = { app, server, io, rooms, getRoomsSummary, soundLibrary, getConfiguredTurnServers, getIceTransportPolicy, getBaseIceServers };
