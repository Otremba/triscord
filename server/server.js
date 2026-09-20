const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const {
  sanitizeUsername,
  sanitizeColor,
  sanitizeStatus,
  sanitizeMessageText,
  sanitizeRoomName,
  sanitizeAttachment,
  sanitizeUserStateUpdate,
  ALLOWED_REACTIONS
} = require('./sanitize');

const app = express();
app.use(cors());

// Serve static renderer files so friends can also join via browser if desired!
app.use(express.static(path.join(__dirname, '../src/renderer')));
app.use('/socket.io-client', express.static(path.join(__dirname, '../node_modules/socket.io-client/dist')));

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
    isSpeaking: u.isSpeaking || false
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

  let currentRoomId = null;
  let currentUserData = null;
  const chatLimiter = makeRateLimiter(6, 4000);
  const reactionLimiter = makeRateLimiter(20, 4000);

  function isOwner(room) {
    return !!room && !!room.ownerUserId && !!currentUserData && room.ownerUserId === currentUserData.userId;
  }

  // Handle joining a voice/video room
  socket.on('join-room', ({ roomId, userData } = {}) => {
    if (typeof roomId !== 'string' || !roomId.trim()) return;
    roomId = roomId.trim().toLowerCase().slice(0, 64);

    // If already in a room, leave it first
    if (currentRoomId && currentRoomId !== roomId) {
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
    const requestingUserId = userData && userData.userId;

    if (!isNewRoom && room.locked && room.ownerUserId !== requestingUserId) {
      socket.emit('room-join-denied', { roomId, reason: 'locked' });
      return;
    }
    if (!isNewRoom && room.maxUsers && room.users.size >= room.maxUsers && room.ownerUserId !== requestingUserId) {
      socket.emit('room-join-denied', { roomId, reason: 'full' });
      return;
    }

    currentRoomId = roomId;
    currentUserData = {
      userId: typeof requestingUserId === 'string' ? requestingUserId.slice(0, 64) : `anon_${socket.id}`,
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

  // WebRTC Signaling: Offer
  socket.on('webrtc-offer', ({ targetSocketId, offer, type } = {}) => {
    if (typeof targetSocketId !== 'string') return;
    io.to(targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      offer,
      type // 'camera', 'screen', or 'mesh'
    });
  });

  // WebRTC Signaling: Answer
  socket.on('webrtc-answer', ({ targetSocketId, answer, type } = {}) => {
    if (typeof targetSocketId !== 'string') return;
    io.to(targetSocketId).emit('webrtc-answer', {
      senderSocketId: socket.id,
      answer,
      type
    });
  });

  // WebRTC Signaling: ICE Candidate
  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate, type } = {}) => {
    if (typeof targetSocketId !== 'string') return;
    io.to(targetSocketId).emit('webrtc-ice-candidate', {
      senderSocketId: socket.id,
      candidate,
      type
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

      // Update global room lists if mute/camera/screen changed
      io.emit('rooms-update', getRoomsSummary());
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

module.exports = { app, server, io, rooms, getRoomsSummary };
